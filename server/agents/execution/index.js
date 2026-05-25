import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS, ACTIONS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { placeMarketOrder } from '../../services/exchangeService.js';
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
  }

  async execute() {
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const signal = this.fusionAgent.getLastSignal(asset);

        if (!signal || signal.action === ACTIONS.HOLD) continue;

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
          continue;
        }

        // Execute trade
        await this.executeTrade(signal, portfolio);
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
    const positionValue = portfolio.availableBalance * positionPct;
    const quantity = positionValue / currentPrice;

    if (quantity <= 0) {
      this.logger.warn(`${signal.asset}: calculated quantity is 0 — skipping`);
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
      positionSize: positionPct * 100,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
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

    // Update trade record
    trade.status = 'open';
    trade.exchangeOrderId = order?.id;
    trade.executedAt = new Date();
    await trade.save();

    // Update portfolio
    portfolio.availableBalance -= positionValue;
    portfolio.totalTrades += 1;
    portfolio.positions.push({
      asset: signal.asset,
      side: signal.action === ACTIONS.BUY ? 'long' : 'short',
      entryPrice: currentPrice,
      currentPrice,
      quantity,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      status: 'open',
    });
    await portfolio.save();

    // Publish execution event
    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      tradeId: trade._id,
      asset: signal.asset,
      action: signal.action,
      price: currentPrice,
      quantity,
      confidence: signal.confidence,
      status: 'executed',
    });

    this.logger.info(
      `✅ ${signal.action} ${quantity.toFixed(6)} ${signal.asset} @ ${currentPrice} (confidence=${signal.confidence.toFixed(2)})`
    );
  }
}
