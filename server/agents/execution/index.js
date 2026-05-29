import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS, ACTIONS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { placeMarketOrder, getExchange } from '../../services/exchangeService.js';
import { sendTelegramMessage, formatPrice } from '../../services/telegramService.js';
import Trade from '../../models/Trade.js';
import Portfolio from '../../models/Portfolio.js';

/**
 * Execution Agent
 * - Receives approved signals from Fusion Agent (after Risk approval).
 * - Places orders on Binance Futures Testnet.
 * - Handles retries, slippage, and failures.
 * - Logs all trade executions.
 */
export default class ExecutionAgent extends BaseAgent {
  constructor(fusionAgent, riskAgent, marketAgent) {
    super(AGENT_NAMES.EXECUTION);
    this.fusionAgent = fusionAgent;
    this.riskAgent = riskAgent;
    this.marketAgent = marketAgent;
    this.pendingOrders = [];
    this.maxRetries = 3;
    this.inFlightAssets = new Set();
    this.processedSignalIds = new Set();
    this.lastExecutedAction = {};
  }

  async execute() {
    for (const asset of SUPPORTED_ASSETS) {
      if (this.inFlightAssets.has(asset)) {
        this.logger.debug(`${asset}: Order already in-flight — skipping cycle execution`);
        continue;
      }

      try {
        const signal = this.fusionAgent.getLastSignal(asset);

        if (!signal) continue;

        // If the signal is HOLD, reset lastExecutedAction to allow future trades when it transitions back to BUY/SELL
        if (signal.action === ACTIONS.HOLD) {
          this.lastExecutedAction[asset] = ACTIONS.HOLD;
          continue;
        }

        // Skip if signal is already processed
        if (signal._id && this.processedSignalIds.has(signal._id.toString())) {
          continue;
        }

        // Prevent immediate re-entry on the same action (e.g. BUY -> close -> BUY immediately)
        if (this.lastExecutedAction[asset] === signal.action) {
          continue;
        }

        // Freshness check: skip if signal is older than 15s
        const signalTime = signal.timestamp || (signal.createdAt ? new Date(signal.createdAt).getTime() : null);
        if (signalTime && Date.now() - signalTime > 15000) {
          this.logger.debug(`${asset}: Signal is stale (${Date.now() - signalTime}ms old) — skipping execution`);
          continue;
        }

        // Get portfolio for the default user (paper trading)
        let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
        if (!portfolio) {
          portfolio = await Portfolio.create({
            userId: null,   // system portfolio for paper trading
            totalBalance: 1000,
            availableBalance: 1000,
          });
        }

        // Risk check
        const riskResult = await this.riskAgent.validateTrade(signal, portfolio);
        if (!riskResult.approved) {
          this.logger.info(`${asset}: Trade rejected — ${riskResult.reason}`);
          
          // If rejected because position is already open, sync our lastExecutedAction state
          if (riskResult.reason.includes('already open') || riskResult.reason.includes('duplicate')) {
            this.lastExecutedAction[asset] = signal.action;
          }
          continue;
        }

        // Mark asset as in-flight and signal as processed
        this.inFlightAssets.add(asset);
        this.lastExecutedAction[asset] = signal.action;
        if (signal._id) {
          this.processedSignalIds.add(signal._id.toString());
          if (this.processedSignalIds.size > 2000) {
            this.processedSignalIds.clear();
          }
        }

        try {
          // Execute trade
          await this.executeTrade(signal, portfolio);
        } finally {
          this.inFlightAssets.delete(asset);
        }
      } catch (err) {
        this.logger.error(`Execution error for ${asset}: ${err.message}`);
      }
    }
  }

  async executeTrade(signal, portfolio) {
    const currentPrice = this.marketAgent.getPrice(signal.asset);
    if (!currentPrice) {
      this.logger.warn(`No price for ${signal.asset} — skipping execution`);
      return;
    }

    // Calculate position size
    const positionPct = parseFloat(signal.positionSize) / 100;
    let positionValue = portfolio.availableBalance * positionPct;

    // Enforce Binance Futures minimum notional order limit of 50 USDT
    const MIN_NOTIONAL = 53; // Base limit updated to 53 USDT (target range 52-55)
    if (positionValue < MIN_NOTIONAL) {
      positionValue = MIN_NOTIONAL;
    }

    const leverage = 10;
    let marginRequired = positionValue / leverage;

    if (portfolio.availableBalance < marginRequired) {
      this.logger.warn(`${signal.asset}: available balance ($${portfolio.availableBalance.toFixed(2)}) is less than required margin ($${marginRequired.toFixed(2)}) for minimum notional ($${MIN_NOTIONAL}) — skipping`);
      return;
    }

    let quantity = positionValue / currentPrice;

    // Retrieve exchange metadata and round quantity UP to the nearest step size to prevent notional limit errors
    try {
      const exchange = getExchange();
      await exchange.loadMarkets();
      const market = exchange.market(signal.asset);
      const stepSize = market.precision?.amount;
      if (stepSize) {
        const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
        const factor = Math.pow(10, decimals);
        quantity = Math.ceil(quantity * factor) / factor;
        
        // Dynamically adjust positionValue to exactly match the rounded-up quantity
        positionValue = quantity * currentPrice;
        marginRequired = positionValue / leverage;
      }
    } catch (err) {
      this.logger.warn(`Failed to dynamically retrieve lot step size for ${signal.asset}: ${err.message}`);
    }

    if (quantity <= 0) {
      this.logger.warn(`${signal.asset}: calculated quantity is 0 — skipping`);
      return;
    }

    const futuresFeeRate = 0.0005; // 0.05% Taker Fee
    const entryFee = positionValue * futuresFeeRate;

    if (portfolio.availableBalance < (marginRequired + entryFee)) {
      this.logger.warn(`${signal.asset}: available balance ($${portfolio.availableBalance.toFixed(2)}) is less than required ($${(marginRequired + entryFee).toFixed(2)}) including margin and 0.05% Taker fee — skipping`);
      return;
    }

    const side = signal.action === ACTIONS.BUY ? 'buy' : 'sell';

    // Create trade record
    const trade = await Trade.create({
      userId: portfolio.userId,
      asset: signal.asset,
      action: signal.action,
      type: 'paper',
      side: signal.action === ACTIONS.BUY ? 'long' : 'short',
      entryPrice: currentPrice,
      quantity,
      positionSize: (positionValue / portfolio.totalBalance) * 100,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      leverage,
      confidence: signal.confidence,
      riskScore: signal.riskScore,
      reasoning: signal.reasoning,
      status: 'pending',
      exchange: 'binance_testnet',
    });

    // Attempt order placement with retries
    let attempt = 0;
    let order = null;

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        order = await placeMarketOrder(signal.asset, side, quantity);
        break;
      } catch (err) {
        this.logger.warn(`Order attempt ${attempt}/${this.maxRetries} failed: ${err.message}`);
        if (attempt >= this.maxRetries) {
          trade.status = 'failed';
          trade.metadata = { error: err.message, attempts: attempt };
          await trade.save();

          this.logger.error(`${signal.asset}: Order FAILED after ${this.maxRetries} attempts`);
          return;
        }
        // Wait before retry (exponential backoff)
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    // Confirm execution parameters from CCXT order response
    const executionPrice = order.average || order.price || currentPrice;
    const executionQuantity = order.filled || order.amount || quantity;

    let actualFee = entryFee;
    if (order.fee && order.fee.cost) {
      actualFee = order.fee.cost;
    } else {
      actualFee = (executionPrice * executionQuantity) * futuresFeeRate;
    }

    const finalMarginRequired = (executionPrice * executionQuantity) / leverage;

    // Increment daily trade count in Risk Agent
    this.riskAgent.incrementDailyTradeCount();

    // Update trade record
    trade.status = 'open';
    trade.entryPrice = executionPrice;
    trade.quantity = executionQuantity;
    trade.exchangeOrderId = order?.id;
    trade.executedAt = new Date(order.timestamp || Date.now());
    trade.fees = actualFee;
    await trade.save();

    // Place native Stop-Loss and Take-Profit orders directly on Binance Demo
    if (order && order.id && !order.id.startsWith('mock_')) {
      try {
        const exchange = getExchange();
        const exitSide = side === 'buy' ? 'sell' : 'buy';
        
        // 1. Native Stop-Loss trigger order
        if (signal.stopLoss) {
          await exchange.createOrder(
            signal.asset,
            'stop_market',
            exitSide,
            quantity,
            undefined,
            {
              stopPrice: signal.stopLoss,
              reduceOnly: true
            }
          );
          this.logger.info(`✅ [NATIVE STOP-LOSS PLACED] stopPrice=${signal.stopLoss} on Binance Demo`);
        }

        // 2. Native Take-Profit trigger order
        if (signal.takeProfit) {
          await exchange.createOrder(
            signal.asset,
            'take_profit_market',
            exitSide,
            quantity,
            undefined,
            {
              stopPrice: signal.takeProfit,
              reduceOnly: true
            }
          );
          this.logger.info(`✅ [NATIVE TAKE-PROFIT PLACED] takeProfitPrice=${signal.takeProfit} on Binance Demo`);
        }
      } catch (triggerErr) {
        this.logger.error(`❌ [NATIVE TRIGGERS PLACEMENT FAILED] Failed to place stop/target orders on Binance Demo: ${triggerErr.message}`);
      }
    }

    // Update portfolio
    portfolio.availableBalance -= (finalMarginRequired + actualFee);
    portfolio.totalTrades += 1;
    portfolio.positions.push({
      asset: signal.asset,
      side: signal.action === ACTIONS.BUY ? 'long' : 'short',
      entryPrice: executionPrice,
      currentPrice: executionPrice,
      quantity: executionQuantity,
      leverage,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      status: 'open',
      fees: actualFee,
    });

    // Recalculate total balance using leverage-adjusted universal equity formula
    const marginValue = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();

    // Publish execution event
    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      tradeId: trade._id,
      asset: signal.asset,
      action: signal.action,
      price: executionPrice,
      quantity: executionQuantity,
      confidence: signal.confidence,
      status: 'executed',
    });

    // Notify Telegram
    await sendTelegramMessage(
      `🔔 <b>Trade Executed! [Auto]</b>\n` +
      `<b>Asset</b>: ${signal.asset.replace('USDT', '')}/USDT\n` +
      `<b>Action</b>: ${signal.action} (${signal.action === 'BUY' ? 'LONG' : 'SHORT'})\n` +
      `<b>Entry Price</b>: $${formatPrice(executionPrice)}\n` +
      `<b>Quantity</b>: ${executionQuantity.toFixed(5)}\n` +
      `<b>Stop Loss</b>: ${signal.stopLoss ? '$' + formatPrice(signal.stopLoss) : '—'}\n` +
      `<b>Target</b>: ${signal.takeProfit ? '$' + formatPrice(signal.takeProfit) : '—'}\n` +
      `<b>Confidence</b>: ${(signal.confidence * 100).toFixed(0)}%`
    );

    this.logger.info(
      `✅ ${signal.action} ${executionQuantity.toFixed(6)} ${signal.asset} @ ${executionPrice} (confidence=${signal.confidence.toFixed(2)})`
    );
  }
}
