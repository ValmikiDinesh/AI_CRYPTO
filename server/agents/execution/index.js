import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS, ACTIONS } from '../../config/constants.js';
import { publishEvent, CHANNELS, subscribeToChannel } from '../../config/redis.js';
import { placeLimitOrder, getExchange } from '../../services/exchangeService.js';
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

  async initialize() {
    await super.initialize();

    // Subscribe to fused signals channel to execute trades instantly when they are published
    await subscribeToChannel(CHANNELS.FUSED_SIGNALS, async (fusedSignal) => {
      try {
        if (fusedSignal && fusedSignal.action !== ACTIONS.HOLD) {
          this.logger.info(`Received live signal event for ${fusedSignal.asset} (${fusedSignal.action})`);
          await this.processSignal(fusedSignal);
        } else if (fusedSignal && fusedSignal.action === ACTIONS.HOLD) {
          this.lastExecutedAction[fusedSignal.asset] = ACTIONS.HOLD;
        }
      } catch (err) {
        this.logger.error(`Error processing subscribed signal for ${fusedSignal?.asset}: ${err.message}`);
      }
    });
  }

  async execute() {
    // 1. Scan and cancel expired pending limit orders (older than 5 minutes)
    try {
      const pendingTrades = await Trade.find({ status: 'pending' });
      const EXPIRATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      
      for (const trade of pendingTrades) {
        const age = Date.now() - new Date(trade.createdAt).getTime();
        if (age >= EXPIRATION_TIMEOUT_MS) {
          this.logger.info(`⏳ Pending trade for ${trade.asset} expired (${Math.round(age / 1000)}s old). Cancelling...`);
          
          try {
            const exchange = getExchange();
            if (trade.exchangeOrderId && !trade.exchangeOrderId.startsWith('mock_')) {
              await exchange.cancelOrder(trade.exchangeOrderId, trade.asset);
            }
          } catch (cancelErr) {
            this.logger.warn(`Failed to cancel expired order ${trade.exchangeOrderId} on exchange: ${cancelErr.message}`);
          }
          
          trade.status = 'cancelled';
          trade.metadata = { ...(trade.metadata || {}), cancelReason: 'Expired (5m limit)' };
          await trade.save();
          
          // Refund margin and fees
          const leverage = trade.leverage || 3;
          const marginReserved = (trade.entryPrice * trade.quantity) / leverage;
          const feeReserved = trade.fees || 0;
          
          let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
          if (portfolio) {
            portfolio.availableBalance += (marginReserved + feeReserved);
            await portfolio.save();
            this.logger.info(`Refunded reserved margin $${marginReserved.toFixed(2)} for expired trade on ${trade.asset}`);
          }
          
          await sendTelegramMessage(
            `⏳ <b>Limit Order Expired</b>\n` +
            `<b>Asset</b>: ${trade.asset.replace('USDT', '')}/USDT\n` +
            `<b>Action</b>: ${trade.action} limit order was cancelled after 5 minutes of no fill.`
          );
        }
      }
    } catch (err) {
      this.logger.error(`Error cleaning up expired pending orders: ${err.message}`);
    }

    // 2. Fallback/sanity check interval execution: check last signals from FusionAgent
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const signal = this.fusionAgent.getLastSignal(asset);
        if (!signal) continue;

        if (signal.action === ACTIONS.HOLD) {
          this.lastExecutedAction[asset] = ACTIONS.HOLD;
          continue;
        }

        // For interval backup check, use a looser freshness window (e.g. 5.5 minutes)
        const signalTime = signal.timestamp || (signal.createdAt ? new Date(signal.createdAt).getTime() : null);
        if (signalTime && Date.now() - signalTime < 330000) {
          await this.processSignal(signal);
        }
      } catch (err) {
        this.logger.error(`Sanity check execution error for ${asset}: ${err.message}`);
      }
    }
  }

  async processSignal(signal) {
    const asset = signal.asset;

    if (this.inFlightAssets.has(asset)) {
      this.logger.debug(`${asset}: Order already in-flight — skipping execution`);
      return;
    }

    // Skip if signal is already processed
    if (signal._id && this.processedSignalIds.has(signal._id.toString())) {
      return;
    }

    // Prevent immediate re-entry on the same action (e.g. BUY -> close -> BUY immediately)
    if (this.lastExecutedAction[asset] === signal.action) {
      return;
    }

    // Freshness check: skip if signal is older than 15s (only applies to fresh execution)
    const signalTime = signal.timestamp || (signal.createdAt ? new Date(signal.createdAt).getTime() : null);
    if (signalTime && Date.now() - signalTime > 15000) {
      this.logger.debug(`${asset}: Signal is stale (${Date.now() - signalTime}ms old) — skipping execution`);
      return;
    }

    // Mark asset as in-flight and signal as processed synchronously to prevent race conditions
    this.inFlightAssets.add(asset);
    if (signal._id) {
      this.processedSignalIds.add(signal._id.toString());
      if (this.processedSignalIds.size > 2000) {
        this.processedSignalIds.clear();
      }
    }

    try {
      // Cancel any existing pending trade/order for this asset first
      try {
        const pendingTrade = await Trade.findOne({ asset, status: 'pending' });
        if (pendingTrade) {
          this.logger.info(`Cancelling existing pending limit order for ${asset} (ID: ${pendingTrade.exchangeOrderId}) before processing new signal`);
          try {
            const exchange = getExchange();
            if (pendingTrade.exchangeOrderId && !pendingTrade.exchangeOrderId.startsWith('mock_')) {
              await exchange.cancelOrder(pendingTrade.exchangeOrderId, asset);
            }
          } catch (cancelErr) {
            this.logger.warn(`Could not cancel order ${pendingTrade.exchangeOrderId} on exchange: ${cancelErr.message}`);
          }
          
          pendingTrade.status = 'cancelled';
          pendingTrade.metadata = { ...(pendingTrade.metadata || {}), cancelReason: 'Superceded by new signal' };
          await pendingTrade.save();
          
          // Refund margin
          const leverage = pendingTrade.leverage || 3;
          const marginReserved = (pendingTrade.entryPrice * pendingTrade.quantity) / leverage;
          const feeReserved = pendingTrade.fees || 0;
          
          let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
          if (portfolio) {
            portfolio.availableBalance += (marginReserved + feeReserved);
            await portfolio.save();
            this.logger.info(`Refunded reserved margin $${marginReserved.toFixed(2)} for cancelled trade on ${asset}`);
          }
        }
      } catch (cancelErr) {
        this.logger.error(`Error during pending trade cleanup for ${asset}: ${cancelErr.message}`);
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
        return;
      }

      this.lastExecutedAction[asset] = signal.action;

      // Execute trade
      await this.executeTrade(signal, portfolio);
    } catch (err) {
      this.logger.error(`Execution error for ${asset}: ${err.message}`);
    } finally {
      this.inFlightAssets.delete(asset);
    }
  }

  async executeTrade(signal, portfolio) {
    const currentPrice = this.marketAgent.getPrice(signal.asset);
    if (!currentPrice) {
      this.logger.warn(`No price for ${signal.asset} — skipping execution`);
      return;
    }

    const limitEntryPrice = signal.limitEntryPrice || currentPrice;

    // Calculate targeted risk amount (e.g. positionPct of available balance)
    const positionPct = parseFloat(signal.positionSize) / 100;
    const riskAmount = portfolio.availableBalance * positionPct;

    // Calculate Stop-Loss percentage distance relative to limitEntryPrice
    const slPercent = signal.stopLoss ? Math.abs(limitEntryPrice - signal.stopLoss) / limitEntryPrice : 0.05;
    
    // Position Value based on Volatility (Risk Parity): positionValue = riskAmount / slPercent
    let positionValue = slPercent > 0.001 ? (riskAmount / slPercent) : (riskAmount / 0.05);

    // Enforce safety limits: cap the maximum margin used for a single trade to 35% of total balance (aggressive)
    const leverage = parseInt(process.env.DEFAULT_LEVERAGE) || 3;
    const maxMargin = portfolio.totalBalance * 0.35;
    const maxNotional = maxMargin * leverage;
    
    if (positionValue > maxNotional) {
      positionValue = maxNotional;
    }

    // Enforce Binance Futures minimum notional order limit of 53 USDT
    const MIN_NOTIONAL = 53;
    if (positionValue < MIN_NOTIONAL) {
      positionValue = MIN_NOTIONAL;
    }

    let marginRequired = positionValue / leverage;

    if (portfolio.availableBalance < marginRequired) {
      this.logger.warn(`${signal.asset}: available balance ($${portfolio.availableBalance.toFixed(2)}) is less than required margin ($${marginRequired.toFixed(2)}) for minimum notional ($${MIN_NOTIONAL}) — skipping`);
      return;
    }

    let quantity = positionValue / limitEntryPrice;

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
        positionValue = quantity * limitEntryPrice;
        marginRequired = positionValue / leverage;
      }
    } catch (err) {
      this.logger.warn(`Failed to dynamically retrieve lot step size for ${signal.asset}: ${err.message}`);
    }

    if (quantity <= 0) {
      this.logger.warn(`${signal.asset}: calculated quantity is 0 — skipping`);
      return;
    }

    const futuresMakerFeeRate = 0.0002; // 0.02% Maker Fee
    const entryFee = positionValue * futuresMakerFeeRate;

    if (portfolio.availableBalance < (marginRequired + entryFee)) {
      this.logger.warn(`${signal.asset}: available balance ($${portfolio.availableBalance.toFixed(2)}) is less than required ($${(marginRequired + entryFee).toFixed(2)}) including margin and 0.02% Maker fee — skipping`);
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
      entryPrice: limitEntryPrice,
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
      metadata: signal.metadata || {},
    });

    // Attempt order placement with retries
    let attempt = 0;
    let order = null;

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        order = await placeLimitOrder(signal.asset, side, quantity, limitEntryPrice);
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
    const executionPrice = order.average || order.price || limitEntryPrice;
    const executionQuantity = order.filled || order.amount || quantity;

    let actualFee = entryFee;
    if (order.fee && order.fee.cost) {
      actualFee = order.fee.cost;
    } else {
      actualFee = (executionPrice * executionQuantity) * futuresMakerFeeRate;
    }

    const finalMarginRequired = (executionPrice * executionQuantity) / leverage;

    // Check if order filled immediately
    const isFilled = order.status === 'closed' || (order.filled && order.filled >= quantity);

    if (isFilled) {
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
      let stopLossOrderId = null;
      if (order && order.id && !order.id.startsWith('mock_')) {
        stopLossOrderId = await this.placeTriggerOrders(signal, executionQuantity, side);
      }

      // Update portfolio positions
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
        stopLossOrderId: stopLossOrderId,
        highestPrice: executionPrice,
        lowestPrice: executionPrice,
        trailingPct: signal.trailingPct || 0.03,
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

      const model = signal.metadata?.sourceModel || 'none';
      const hasAiTargets = signal.metadata?.usedAiTargets;
      const modelName = model === 'ai_groq' ? 'Groq AI' : model === 'ai_openai' ? 'OpenAI' : model.includes('ai_') ? 'Gemini' : 'Statistical';
      const strategy = hasAiTargets ? `${modelName} (AI-Decided Entry/SL/TP)` : `${modelName} (Regime pullback)`;

      // Notify Telegram
      await sendTelegramMessage(
        `🔔 <b>Trade Executed! [Auto]</b>\n` +
        `<b>Asset</b>: ${signal.asset.replace('USDT', '')}/USDT\n` +
        `<b>Action</b>: ${signal.action} (${signal.action === 'BUY' ? 'LONG' : 'SHORT'})\n` +
        `<b>Strategy</b>: ${strategy}\n` +
        `<b>Entry Price</b>: $${formatPrice(executionPrice)}\n` +
        `<b>Quantity</b>: ${executionQuantity.toFixed(5)}\n` +
        `<b>Stop Loss</b>: ${signal.stopLoss ? '$' + formatPrice(signal.stopLoss) : '—'}\n` +
        `<b>Target</b>: ${signal.takeProfit ? '$' + formatPrice(signal.takeProfit) : '—'}\n` +
        `<b>Confidence</b>: ${(signal.confidence * 100).toFixed(0)}%`
      );

      this.logger.info(
        `✅ ${signal.action} ${executionQuantity.toFixed(6)} ${signal.asset} @ ${executionPrice} (confidence=${signal.confidence.toFixed(2)})`
      );
    } else {
      // Order is pending: save as pending trade and do not push to portfolio.positions yet
      trade.status = 'pending';
      trade.entryPrice = limitEntryPrice;
      trade.quantity = quantity;
      trade.exchangeOrderId = order?.id;
      trade.fees = actualFee;
      await trade.save();

      // Deduct margin from available balance locally to reserve it
      portfolio.availableBalance -= (finalMarginRequired + actualFee);
      await portfolio.save();

      this.logger.info(`⏳ Limit order placed and pending on Binance for ${signal.asset} @ ${limitEntryPrice} (ID: ${order?.id})`);

      const model = signal.metadata?.sourceModel || 'none';
      const hasAiTargets = signal.metadata?.usedAiTargets;
      const modelName = model === 'ai_groq' ? 'Groq AI' : model === 'ai_openai' ? 'OpenAI' : model.includes('ai_') ? 'Gemini' : 'Statistical';
      const strategy = hasAiTargets ? `${modelName} (AI-Decided Entry/SL/TP)` : `${modelName} (Regime pullback)`;

      // Notify Telegram
      await sendTelegramMessage(
        `⏳ <b>Limit Order Placed! [Pending]</b>\n` +
        `<b>Asset</b>: ${signal.asset.replace('USDT', '')}/USDT\n` +
        `<b>Action</b>: ${signal.action} (${signal.action === 'BUY' ? 'LONG' : 'SHORT'})\n` +
        `<b>Strategy</b>: ${strategy}\n` +
        `<b>Limit Price</b>: $${formatPrice(limitEntryPrice)}\n` +
        `<b>Current Price</b>: $${formatPrice(currentPrice)}\n` +
        `<b>Quantity</b>: ${quantity.toFixed(5)}\n` +
        `<b>Stop Loss</b>: ${signal.stopLoss ? '$' + formatPrice(signal.stopLoss) : '—'}\n` +
        `<b>Target</b>: ${signal.takeProfit ? '$' + formatPrice(signal.takeProfit) : '—'}`
      );
    }
  }

  async placeTriggerOrders(signal, quantity, side) {
    let stopLossOrderId = null;
    try {
      const exchange = getExchange();
      await exchange.loadMarkets();
      const exitSide = side === 'buy' ? 'sell' : 'buy';
      
      const formattedAmount = parseFloat(exchange.amountToPrecision(signal.asset, quantity));
      
      // 1. Native Stop-Loss trigger order
      if (signal.stopLoss) {
        const formattedStopLoss = parseFloat(exchange.priceToPrecision(signal.asset, signal.stopLoss));
        const slOrderResult = await exchange.createOrder(
          signal.asset,
          'stop_market',
          exitSide,
          formattedAmount,
          undefined,
          {
            stopPrice: formattedStopLoss,
            reduceOnly: true
          }
        );
        stopLossOrderId = slOrderResult?.id;
        this.logger.info(`✅ [NATIVE STOP-LOSS PLACED] stopPrice=${formattedStopLoss} id=${stopLossOrderId} on Binance Demo`);
      }

      // 2. Native Take-Profit trigger order
      if (signal.takeProfit) {
        const formattedTakeProfit = parseFloat(exchange.priceToPrecision(signal.asset, signal.takeProfit));
        await exchange.createOrder(
          signal.asset,
          'take_profit_market',
          exitSide,
          formattedAmount,
          undefined,
          {
            stopPrice: formattedTakeProfit,
            reduceOnly: true
          }
        );
        this.logger.info(`✅ [NATIVE TAKE-PROFIT PLACED] takeProfitPrice=${formattedTakeProfit} on Binance Demo`);
      }
    } catch (triggerErr) {
      this.logger.error(`❌ [NATIVE TRIGGERS PLACEMENT FAILED] Failed to place stop/target orders on Binance Demo: ${triggerErr.message}`);
    }
    return stopLossOrderId;
  }
}
