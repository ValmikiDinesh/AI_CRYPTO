import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, publishEvent, CHANNELS } from '../../config/redis.js';
import { ACTIONS } from '../../config/constants.js';
import Trade from '../../models/Trade.js';
import Portfolio from '../../models/Portfolio.js';

export default class OmsAgent extends BaseAgent {
  constructor(riskAgent) {
    super('oms');
    this.riskAgent = riskAgent;
    this.inFlightAssets = new Set();
  }

  async initialize() {
    this.logger.info('Initializing Order Management Service (OMS)...');
    
    // Sweep ghost locks from previous crashes
    try {
      const result = await Trade.updateMany(
        { status: { $in: ['oms_approved', 'pending'] } },
        { $set: { status: 'failed', reasoning: 'Ghost lock sweep on OMS boot' } }
      );
      if (result.modifiedCount > 0) {
        this.logger.info(`🧹 OMS Startup Sweep: Unlocked ${result.modifiedCount} "Ghost Lock" trades from previous session crashes.`);
      }

      // 🛡️ Round 70: Revert trades stuck in closing_in_progress so the AI can regain control
      const revertResult = await Trade.updateMany(
        { status: 'closing_in_progress' },
        { $set: { status: 'open', reasoning: 'Ghost lock sweep: Reverted closing_in_progress to open on boot' } }
      );
      if (revertResult.modifiedCount > 0) {
        this.logger.info(`🧹 OMS Startup Sweep: Reverted ${revertResult.modifiedCount} "closing_in_progress" trades back to 'open'.`);
      }
    } catch (err) {
      this.logger.error(`OMS Startup Sweep failed: ${err.message}`);
    }

    await subscribeToChannel(CHANNELS.FUSED_SIGNALS, this.processSignal.bind(this));
  }

  async processSignal(signal) {
    if (!signal || !signal.asset || !signal.action) return;
    if (signal.action !== ACTIONS.BUY && signal.action !== ACTIONS.SELL) return;
    if (this.inFlightAssets.has(signal.asset)) {
      this.logger.debug(`${signal.asset}: Order already in-flight — skipping OMS check`);
      return;
    }
    
    try {
      this.inFlightAssets.add(signal.asset);
      let portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
      if (!portfolio) {
        portfolio = await Portfolio.create({ userId: 'system' });
      }

      // Dynamic Multi-Strategy Engine: Read custom confidence threshold
      const activeStrategy = portfolio.activeStrategy || 'trend_sniper';
      let requiredConfidence = 0.70; // Hard fallback
      
      if (portfolio.strategySettings && portfolio.strategySettings[activeStrategy] && portfolio.strategySettings[activeStrategy].confidenceThreshold !== undefined) {
        requiredConfidence = portfolio.strategySettings[activeStrategy].confidenceThreshold;
      } else {
        requiredConfidence = activeStrategy === 'trend_sniper' ? 0.75 : 0.60;
      }

      // Only process signals if confidence is high enough for the active strategy
      if (signal.confidence < requiredConfidence) {
        this.logger.debug(`Signal confidence too low (${signal.confidence} < ${requiredConfidence} required by ${activeStrategy}) for ${signal.asset}`);
        this.inFlightAssets.delete(signal.asset);
        return;
      }

      if (portfolio.tradingPaused) {
        this.logger.debug(`Trading is paused — ignoring signal for ${signal.asset}`);
        return;
      }

      if (portfolio.isSquaringOff) {
        this.logger.debug(`Portfolio is in square-off mode — ignoring signal for ${signal.asset}`);
        return;
      }

      if (portfolio.manuallyDisabledAssets && portfolio.manuallyDisabledAssets.includes(signal.asset)) {
        this.logger.debug(`Asset ${signal.asset} is manually disabled — ignoring signal`);
        return;
      }
      
      const openTrade = await Trade.findOne({
        asset: signal.asset,
        status: { $in: ['open', 'oms_approved', 'pending'] }
      });

      if (openTrade) {
        this.logger.debug(`Active/Pending trade already exists in DB for ${signal.asset} — skipping`);
        return;
      }

      // 🛡️ Orphaned Risk Engine Re-engaged
      if (this.riskAgent) {
        const riskResult = await this.riskAgent.validateTrade(signal, portfolio);
        if (!riskResult.approved) {
          this.logger.warn(`OMS: Risk Engine Rejected Trade for ${signal.asset} - ${riskResult.reason}`);
          return;
        }
      } else {
        this.logger.warn(`OMS: ⚠️ RiskAgent missing! Proceeding without pre-flight risk checks.`);
      }

      await this.validateAndSizeOrder(signal, portfolio);
    } catch (err) {
      this.logger.error(`Error processing signal for ${signal.asset}: ${err.message}`);
    } finally {
      this.inFlightAssets.delete(signal.asset);
    }
  }

  async validateAndSizeOrder(signal, portfolio) {
    // Robust live price fetch
    let limitEntryPrice = signal.limitEntryPrice || signal.metadata?.currentPrice;
    
    if (!limitEntryPrice || limitEntryPrice <= 0.00000001) {
      try {
        const { getExchange } = await import('../../services/exchangeService.js');
        const exchange = getExchange();
        const ticker = await exchange.fetchTicker(signal.asset);
        if (ticker && ticker.last) {
          limitEntryPrice = ticker.last;
          this.logger.info(`OMS: Fetched live price $${limitEntryPrice} for ${signal.asset} (Missing in signal)`);
        } else {
          throw new Error('No last price in ticker');
        }
      } catch (err) {
        this.logger.error(`OMS: FATAL - Could not fetch live price for ${signal.asset}. Aborting trade to prevent catastrophic position sizing. Error: ${err.message}`);
        return;
      }
    }

    // 1. Calculate base Risk Amount
    const positionPct = parseFloat(signal.positionSize || 2.0) / 100;
    
    // Direct Kelly Allocation (AI already calculated the optimal allocation size)
    let positionValue = portfolio.totalBalance * positionPct;

    // 3. Dynamic Margin Check
    const leverage = portfolio.defaultLeverage || parseInt(process.env.DEFAULT_LEVERAGE) || 5;
    const MIN_MARGIN_FLOOR = portfolio.minMarginFloor !== undefined ? portfolio.minMarginFloor : (parseFloat(process.env.MIN_MARGIN_FLOOR) || 5.0); 
    
    let marginRequired = positionValue / leverage;
    
    // 4. Margin Floor Enforcement (Overwrites parity ONLY if below floor)
    if (marginRequired < MIN_MARGIN_FLOOR) {
      marginRequired = MIN_MARGIN_FLOOR;
      positionValue = MIN_MARGIN_FLOOR * leverage;
    }

    // 5. Available Balance Constraint
    const futuresMakerFeeRate = 0.0002;
    
    // 🛡️ FIX: Catastrophic Margin Over-Allocation Bug.
    // Calculate total margin currently locked in pending 'oms_approved' limit orders.
    const pendingTrades = await Trade.find({ status: 'oms_approved' });
    let lockedMargin = 0;
    for (const pt of pendingTrades) {
      const ptMargin = (pt.entryPrice * pt.quantity) / (pt.leverage || leverage);
      const ptFee = (pt.entryPrice * pt.quantity) * futuresMakerFeeRate;
      lockedMargin += (ptMargin + ptFee);
    }
    const trueAvailableBalance = portfolio.availableBalance - lockedMargin;

    if (trueAvailableBalance < (marginRequired + (positionValue * futuresMakerFeeRate))) {
      // Balance Exhaustion Deadlock Fix: Algebraically calculate maximum possible position value including fees
      const maxPositionValue = trueAvailableBalance / ((1 / leverage) + futuresMakerFeeRate);
      const maxMargin = maxPositionValue / leverage;

      if (maxMargin >= MIN_MARGIN_FLOOR) {
        marginRequired = maxMargin;
        positionValue = maxPositionValue;
      } else {
        this.logger.warn(`Available balance ($${trueAvailableBalance.toFixed(2)}) minus locked limit margin ($${lockedMargin.toFixed(2)}) is insufficient for ${signal.asset} floor + fees — skipping`);
        return;
      }
    }

    let quantity = positionValue / limitEntryPrice;
    const entryFee = positionValue * futuresMakerFeeRate;

    // 🛡️ FIX: Minimum Lot Size Validation
    try {
      const { getExchange } = await import('../../services/exchangeService.js');
      const exchange = getExchange();
      if (Object.keys(exchange.markets).length === 0) {
        await exchange.loadMarkets();
      }
      const assetLimits = exchange.markets[signal.asset];
      if (assetLimits && assetLimits.limits && assetLimits.limits.amount && assetLimits.limits.amount.min) {
        if (quantity < assetLimits.limits.amount.min) {
          this.logger.warn(`OMS: Calculated quantity ${quantity} for ${signal.asset} is below exchange absolute minimum allowed lot size (${assetLimits.limits.amount.min}). Rejecting order silently to prevent exchange API rejection crash.`);
          return;
        }
      }
    } catch (limitErr) {
      this.logger.warn(`OMS: Failed to verify minimum lot size limits for ${signal.asset}: ${limitErr.message}`);
    }

    // Create OMS Trade record (pending execution)
    const trade = await Trade.create({
      userId: portfolio.userId,
      asset: signal.asset,
      action: signal.action,
      type: 'live',
      side: signal.action === ACTIONS.BUY ? 'long' : 'short',
      entryPrice: limitEntryPrice,
      quantity,
      positionSize: (positionValue / portfolio.totalBalance) * 100,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      leverage,
      confidence: signal.confidence,
      status: 'oms_approved',
      exchange: 'coinswitch',
      metadata: signal.metadata || {},
    });

    this.logger.info(`✅ OMS Approved Order for ${signal.asset} (${trade.side.toUpperCase()}). Routing to EMS...`);

    // Route to EMS
    await publishEvent(CHANNELS.OMS_APPROVED_ORDERS, {
      tradeId: trade._id.toString(),
      asset: signal.asset,
      side: trade.side,
      quantity: trade.quantity,
      limitEntryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      leverage: trade.leverage
    });
  }

  async execute() {}
}
