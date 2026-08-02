import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, publishEvent, CHANNELS } from '../../config/redis.js';
import Portfolio from '../../models/Portfolio.js';
import Trade from '../../models/Trade.js';

export default class SweepProfitAgent extends BaseAgent {
  constructor() {
    super('sweep');
    this.openPositions = new Map();
    this.sweepTargetProfitPct = 10;
    this.baseTradingCapital = 100;
    this.availableBalance = 100;
    this.targetProfitThreshold = 110;
    this.isSquaringOff = false;
    this.futuresMakerFeeRate = 0.0005; // 0.05% Taker fee on CoinSwitch
    this.lastSweepTime = 0;
  }

  async initialize() {
    this.logger.info('Initializing Sweep Profit Service...');
    
    const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
    if (portfolio) {
      this.sweepTargetProfitPct = portfolio.sweepTargetProfitPct !== undefined ? portfolio.sweepTargetProfitPct : 10;
      this.baseTradingCapital = portfolio.baseTradingCapital || 100;
      this.availableBalance = portfolio.availableBalance !== undefined ? portfolio.availableBalance : this.baseTradingCapital;
      this.targetProfitThreshold = portfolio.targetProfitThreshold !== undefined ? portfolio.targetProfitThreshold : (this.baseTradingCapital * 1.10);
      this.isSquaringOff = portfolio.isSquaringOff || false;
      this.tradingPaused = portfolio.tradingPaused || false;
      if (portfolio.positions) {
        portfolio.positions.forEach(p => {
          if (p.status === 'open') {
            this.openPositions.set(p.asset, p);
          }
        });
      }
    }

    await subscribeToChannel(CHANNELS.TRADE_EXECUTIONS, this.handleTradeExecution.bind(this));
    await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, this.handlePortfolioUpdate.bind(this));
    await subscribeToChannel(CHANNELS.MARKET_DATA, this.handleMarketTick.bind(this));
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
    if (portfolio.sweepTargetProfitPct !== undefined) {
      this.sweepTargetProfitPct = portfolio.sweepTargetProfitPct;
    }
    if (portfolio.availableBalance !== undefined) {
      this.availableBalance = portfolio.availableBalance;
    }
    if (portfolio.targetProfitThreshold !== undefined) {
      this.targetProfitThreshold = portfolio.targetProfitThreshold;
    }
    if (portfolio.isSquaringOff !== undefined) {
      this.isSquaringOff = portfolio.isSquaringOff;
    }
    if (portfolio.tradingPaused !== undefined) {
      this.tradingPaused = portfolio.tradingPaused;
    }

    // 🛡️ FIX: Agent Blindness Bug. Implement Two-Way RAM/DB Memory Synchronization
    if (portfolio.positions) {
      const dbAssets = new Set();
      
      // 1. Actively recover missing positions into RAM
      for (const p of portfolio.positions) {
        if (p.status === 'open') {
          dbAssets.add(p.asset);
          if (!this.openPositions.has(p.asset)) {
            this.logger.info(`🔄 Recovering Missing Position ${p.asset} into SweepAgent memory`);
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
          this.logger.info(`🧹 Sweeping Ghost Position ${asset} from SweepAgent memory`);
          this.openPositions.delete(asset);
        }
      }
    }
  }

  async handleMarketTick(tickPayload) {
    if (!this.sweepTargetProfitPct || this.sweepTargetProfitPct <= 0) return; // FIX: Respect explicit disabling

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
      if (this.isSquaringOff && !this.tradingPaused) {
        // Reset square off since everything is closed, but ONLY if the system isn't globally paused by RiskAgent
        this.isSquaringOff = false;
        
        // Auto-Compound: Fetch live exchange balance directly to bypass Reconciliation API lag
        let newBaseCapital = this.availableBalance;
        try {
          const { fetchBalance } = await import('../../services/exchangeService.js');
          const liveBal = await fetchBalance(true);
          if (liveBal && liveBal.USDT) {
             newBaseCapital = liveBal.USDT.total;
          }
        } catch (balErr) {
           this.logger.warn(`SweepAgent failed to fetch live balance for auto-compounding, falling back to cache: ${balErr.message}`);
        }
        
        const newThreshold = newBaseCapital * (1 + (this.sweepTargetProfitPct / 100));
        this.baseTradingCapital = newBaseCapital;
        this.targetProfitThreshold = newThreshold;

        await Portfolio.updateOne(
          { userId: 'system' }, 
          { $set: { 
              isSquaringOff: false,
              baseTradingCapital: newBaseCapital,
              targetProfitThreshold: newThreshold
          }}
        );
        this.logger.info(`🔄 Sweep Profit Complete! Auto-Compounding activated. New Base Capital: $${newBaseCapital.toFixed(2)}. Next Frozen Milestone: $${newThreshold.toFixed(2)}`);
      }
      return;
    }

    if (!positionsUpdated) return;

    // Only run expensive global check periodically on this tick (e.g. 1 in 10 chance or when many ticks arrive)
    // For now, we calculate total net PnL every time a tick updates an asset
    let totalMarginUsed = 0;
    let totalNetUnrealizedPnl = 0;
    for (const [_, p] of this.openPositions.entries()) {
      if (!p.currentPrice) continue;
      const margin = (p.entryPrice * p.quantity) / (p.leverage || 1);
      const unrealizedPnl = p.side === 'long'
        ? (p.currentPrice - p.entryPrice) * p.quantity
        : (p.entryPrice - p.currentPrice) * p.quantity;
      const openFee = (p.entryPrice * p.quantity) * this.futuresMakerFeeRate;
      const closeFee = (p.currentPrice * p.quantity) * this.futuresMakerFeeRate;
      
      totalMarginUsed += margin;
      totalNetUnrealizedPnl += (unrealizedPnl - openFee - closeFee);
    }

    const currentTotalBalance = this.availableBalance + totalMarginUsed + totalNetUnrealizedPnl;

    if (currentTotalBalance >= this.targetProfitThreshold && !this.isSquaringOff) {
      this.logger.info(`[SWEEP EXIT] Absolute Milestone Reached! Current Total Balance $${currentTotalBalance.toFixed(2)} >= Threshold $${this.targetProfitThreshold.toFixed(2)}. Triggering mass square-off and shutting down bot!`);
      
      this.isSquaringOff = true;
      this.lastSweepTime = Date.now();
      await Portfolio.updateOne({ userId: 'system' }, { $set: { isSquaringOff: true, tradingPaused: true } });

      for (const [asset, p] of this.openPositions.entries()) {
        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: p.asset,
          side: p.side,
          quantity: p.quantity,
          currentPrice: p.currentPrice,
          forceMarket: true,
          reason: `Absolute Sweep Milestone reached (Threshold $${this.targetProfitThreshold.toFixed(2)})`
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
                this.logger.warn(`🚨 [SWEEP] Zombie Limit Order for ${trade.asset} was PARTIALLY FILLED (${partiallyFilledQty}). Promoting to OPEN and triggering Emergency Exit!`);
                trade.status = 'open';
                trade.quantity = partiallyFilledQty;
                trade.executedAt = new Date();
                trade.reasoning = 'Partial Fill rescued during Absolute Sweep Square-Off';
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
                  reason: `Absolute Sweep Square-Off (Rescued Partial Fill)`
                });
              } else {
                trade.status = 'failed';
                trade.reasoning = 'Zombie Limit Order explicitly canceled due to Absolute Sweep Square-Off';
                await trade.save();
              }
            }
          }
        }
      } catch (err) {
        this.logger.error(`Failed to sweep zombie orders: ${err.message}`);
      }
    } else if (this.isSquaringOff) {
      // If we are actively squaring off but some positions remain (retry mechanism)
      // Only retry every 15 seconds to prevent DDoS flooding the EMS queue on every 50ms tick
      if (Date.now() - this.lastSweepTime > 15000) {
        this.lastSweepTime = Date.now();
        for (const [asset, p] of this.openPositions.entries()) {
          await publishEvent(CHANNELS.EXIT_REQUESTS, {
            asset: p.asset,
            side: p.side,
            quantity: p.quantity,
            currentPrice: p.currentPrice,
            forceMarket: true,
            reason: `Basket Square-Off Active (Retrying exit for ${asset})`
          });
        }
      }
    }
  }

  async execute() {}
}
