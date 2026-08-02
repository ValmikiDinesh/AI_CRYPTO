import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, publishEvent, CHANNELS } from '../../config/redis.js';
import Portfolio from '../../models/Portfolio.js';
import Trade from '../../models/Trade.js';

export default class BasketProfitAgent extends BaseAgent {
  constructor() {
    super('basket');
    this.openPositions = new Map();
    this.futuresMakerFeeRate = 0.0005; // 0.05% Taker fee on CoinSwitch
    this.basketProfitTargetPct = 10;
    this.baseTradingCapital = 100;
    this.isSquaringOff = false;
    this.lastSweepTime = 0;
  }

  async initialize() {
    this.logger.info('Initializing Basket Profit Service (Global PnL)...');
    
    const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
    if (portfolio) {
      this.basketProfitTargetPct = portfolio.basketProfitTargetPct !== undefined ? portfolio.basketProfitTargetPct : 10;
      this.baseTradingCapital = portfolio.baseTradingCapital || 100;
      if (portfolio.positions) {
        portfolio.positions.forEach(p => {
          if (p.status === 'open') {
            this.openPositions.set(p.asset, p);
          }
        });
      }
    }

    await subscribeToChannel(CHANNELS.TRADE_EXECUTIONS, this.handleTradeExecution.bind(this));
    await subscribeToChannel(CHANNELS.MARKET_DATA, this.handleMarketTick.bind(this));
    await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, this.handlePortfolioUpdate.bind(this));
  }

  handleTradeExecution(payload) {
    if (payload.type === 'ENTRY') {
      this.openPositions.set(payload.asset, {
        asset: payload.asset,
        side: payload.side,
        quantity: payload.quantity,
        entryPrice: payload.price,
        leverage: payload.leverage || 1,
      });
    } else if (payload.type === 'EXIT') {
      this.openPositions.delete(payload.asset);
    } else if (payload.type === 'PARTIAL_EXIT') {
      const pos = this.openPositions.get(payload.asset);
      if (pos) {
        pos.quantity -= payload.quantity;
        if (pos.quantity <= 0) {
          this.openPositions.delete(payload.asset);
        }
      }
    }
  }

  handlePortfolioUpdate(portfolio) {
    if (portfolio.basketProfitTargetPct !== undefined) {
      this.basketProfitTargetPct = portfolio.basketProfitTargetPct;
    }
    if (portfolio.baseTradingCapital !== undefined) {
      this.baseTradingCapital = portfolio.baseTradingCapital;
    }

    // 🛡️ FIX: Agent Blindness Bug. Implement Two-Way RAM/DB Memory Synchronization
    if (portfolio.positions) {
      const dbAssets = new Set();
      
      // 1. Actively recover missing positions into RAM
      for (const p of portfolio.positions) {
        if (p.status === 'open') {
          dbAssets.add(p.asset);
          if (!this.openPositions.has(p.asset)) {
            this.logger.info(`🔄 Recovering Missing Position ${p.asset} into BasketAgent memory`);
            this.openPositions.set(p.asset, {
              asset: p.asset,
              side: p.side,
              quantity: p.quantity,
              entryPrice: p.entryPrice,
              leverage: p.leverage || 1,
            });
          } else {
            // Sync partial fill shrinkages to prevent calculation skew
            const cached = this.openPositions.get(p.asset);
            cached.quantity = p.quantity;
            cached.entryPrice = p.entryPrice;
          }
        }
      }

      // 2. Sweep Ghost Positions from RAM
      for (const asset of this.openPositions.keys()) {
        if (!dbAssets.has(asset)) {
          this.logger.info(`🧹 Sweeping Ghost Position ${asset} from BasketAgent memory`);
          this.openPositions.delete(asset);
        }
      }
    }
  }

  async handleMarketTick(tickPayload) {
    if (!this.basketProfitTargetPct || this.basketProfitTargetPct <= 0) return; // FIX: Respect explicit disabling

    let ticks = [];
    if (tickPayload.type === 'bulk_ticks') {
      ticks = tickPayload.ticks;
    } else if (tickPayload.type === 'snapshot') {
      return; 
    } else {
      ticks = [tickPayload]; // Legacy fallback
    }

    let positionsUpdated = false;

    for (const tick of ticks) {
      const symbol = tick.asset || tick.symbol;
      if (!symbol) continue;

      const pos = this.openPositions.get(symbol);
      if (pos) {
        pos.currentPrice = tick.price;
        positionsUpdated = true;
      }
    }

    if (this.openPositions.size === 0) {
      if (this.isSquaringOff) {
        this.isSquaringOff = false;
        await Portfolio.updateOne({ userId: 'system' }, { $set: { isSquaringOff: false } });
        this.logger.info(`🔄 Global Basket Profit Reset: All positions closed.`);
      }
      return;
    }

    if (!positionsUpdated) return;

    let totalNetUnrealizedPnl = 0;
    for (const [_, p] of this.openPositions.entries()) {
      if (!p.currentPrice) continue;
      
      const unrealizedPnl = p.side === 'long'
        ? (p.currentPrice - p.entryPrice) * p.quantity
        : (p.entryPrice - p.currentPrice) * p.quantity;
      const openFee = (p.entryPrice * p.quantity) * this.futuresMakerFeeRate;
      const closeFee = (p.currentPrice * p.quantity) * this.futuresMakerFeeRate;
      
      totalNetUnrealizedPnl += (unrealizedPnl - openFee - closeFee);
    }

    const targetUsd = this.baseTradingCapital * (this.basketProfitTargetPct / 100);

    if (totalNetUnrealizedPnl >= targetUsd && !this.isSquaringOff) {
      this.logger.info(`[BASKET EXIT] Global net profit $${totalNetUnrealizedPnl.toFixed(2)} >= $${targetUsd.toFixed(2)}. Squaring off all positions!`);
      this.isSquaringOff = true;
      await Portfolio.updateOne({ userId: 'system' }, { $set: { isSquaringOff: true } });
      this.lastSweepTime = Date.now();

      for (const [_, p] of this.openPositions.entries()) {
        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: p.asset,
          side: p.side,
          quantity: p.quantity,
          currentPrice: p.currentPrice,
          forceMarket: true,
          reason: `Global Basket Take Profit reached`
        });
      }
      
      // 🧟 Destroy all pending Zombie Limit Orders to prevent re-entry
      try {
        const pendingTrades = await Trade.find({ status: { $in: ['oms_approved', 'pending'] } });
        if (pendingTrades.length > 0) {
          const { cancelOrder, fetchOpenOrders } = await import('../../services/exchangeService.js');
          for (const trade of pendingTrades) {
            if (trade.exchangeOrderId) {
              let partiallyFilledQty = 0;
              try {
                const liveOrders = await fetchOpenOrders(trade.asset).catch(() => []);
                const order = liveOrders.find(o => o.id === trade.exchangeOrderId);
                if (order && order.filled > 0) {
                  partiallyFilledQty = order.filled;
                }
              } catch (e) {
                this.logger.warn(`Failed to verify partial fill for zombie order ${trade.exchangeOrderId}: ${e.message}`);
              }

              await cancelOrder(trade.exchangeOrderId, trade.asset).catch(() => {});
              
              if (partiallyFilledQty > 0) {
                this.logger.warn(`🚨 [BASKET] Zombie Limit Order for ${trade.asset} was PARTIALLY FILLED (${partiallyFilledQty}). Promoting to OPEN and triggering Emergency Exit!`);
                trade.status = 'open';
                trade.quantity = partiallyFilledQty;
                trade.executedAt = new Date();
                trade.reasoning = 'Partial Fill rescued during Global Basket Square-Off';
                await trade.save();
                
                const futuresMakerFeeRate = 0.0005;
                const feeUsdt = (trade.entryPrice * partiallyFilledQty) * futuresMakerFeeRate;
                const marginUsed = (trade.entryPrice * partiallyFilledQty) / (trade.leverage || 1);
                await Portfolio.updateOne(
                  { userId: 'system' },
                  { 
                    $push: { positions: {
                      tradeId: trade._id.toString(),
                      asset: trade.asset,
                      side: trade.side,
                      entryPrice: trade.entryPrice,
                      quantity: partiallyFilledQty,
                      leverage: trade.leverage || 1,
                      status: 'open',
                      openedAt: trade.executedAt,
                      fees: feeUsdt,
                      category: trade.category || 'other'
                    } },
                    $inc: { 
                      availableBalance: -marginUsed - feeUsdt,
                      totalBalance: -feeUsdt,
                      dailyLossToday: -feeUsdt,
                      totalPnl: -feeUsdt
                    }
                  }
                );
                
                await publishEvent(CHANNELS.EXIT_REQUESTS, {
                  asset: trade.asset,
                  side: trade.side,
                  quantity: partiallyFilledQty,
                  currentPrice: trade.entryPrice,
                  forceMarket: true,
                  reason: `Global Basket Square-Off (Rescued Partial Fill)`
                });
              } else {
                trade.status = 'failed';
                trade.reasoning = 'Zombie Limit Order explicitly canceled due to Global Basket Square-Off';
                await trade.save();
              }
            }
          }
        }
      } catch (err) {
        this.logger.error(`Failed to sweep zombie orders: ${err.message}`);
      }
    } else if (this.isSquaringOff) {
      if (Date.now() - this.lastSweepTime > 15000) {
        this.lastSweepTime = Date.now();
        for (const [_, p] of this.openPositions.entries()) {
          await publishEvent(CHANNELS.EXIT_REQUESTS, {
            asset: p.asset,
            side: p.side,
            quantity: p.quantity,
            currentPrice: p.currentPrice,
            forceMarket: true,
            reason: `Global Basket Square-Off Active (Retrying exit for ${p.asset})`
          });
        }
      }
    }
  }

  async execute() {}
}
