import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, publishEvent, CHANNELS } from '../../config/redis.js';
import Portfolio from '../../models/Portfolio.js';

export default class TrailingSlAgent extends BaseAgent {
  constructor() {
    super('trailing');
    this.openPositions = new Map();
    this.trailingStopUsd = null;
    this.trailingStopMinFloorUsd = 0.10;
    this.enableTrailingStop = true;
    this.enableTrailingFloor = true;
    this.futuresMakerFeeRate = 0.0005; // 0.05% Taker fee on CoinSwitch
    this.isSquaringOff = false;
  }

  async initialize() {
    this.logger.info('Initializing Trailing SL Service...');
    
    // Load initial state
    const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
    if (portfolio) {
      this.trailingStopUsd = portfolio.trailingStopUsd;
      this.trailingStopMinFloorUsd = portfolio.trailingStopMinFloorUsd !== undefined ? portfolio.trailingStopMinFloorUsd : 0.10;
      this.enableTrailingStop = portfolio.enableTrailingStop !== undefined ? portfolio.enableTrailingStop : true;
      this.enableTrailingFloor = portfolio.enableTrailingFloor !== undefined ? portfolio.enableTrailingFloor : true;
      this.isSquaringOff = portfolio.isSquaringOff;
      if (portfolio.positions) {
        portfolio.positions.forEach(p => {
          if (p.status === 'open') {
            this.openPositions.set(p.asset, {
              asset: p.asset,
              side: p.side,
              quantity: p.quantity,
              entryPrice: p.entryPrice,
              highestNetPnl: p.highestProfitMilestone || 0,
              trailingAtrMult: p.trailingAtrMult,
              entryAtr: p.entryAtr
            });
          }
        });
      }
    }

    // Subscribe to channels
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
        highestNetPnl: 0,
        trailingAtrMult: payload.trailingAtrMult,
        entryAtr: payload.entryAtr
      });
    } else if (payload.type === 'EXIT') {
      this.openPositions.delete(payload.asset);
    } else if (payload.type === 'PARTIAL_EXIT') {
      const pos = this.openPositions.get(payload.asset);
      if (pos) {
        const oldQuantity = pos.quantity;
        pos.quantity -= payload.quantity;
        if (pos.quantity <= 0) {
          this.openPositions.delete(payload.asset);
        } else if (oldQuantity > 0) {
          // Proportionally shrink highest peak to prevent instant fake-out trigger
          pos.highestNetPnl = pos.highestNetPnl * (pos.quantity / oldQuantity);
        }
      }
    }
  }

  handlePortfolioUpdate(portfolio) {
    if (portfolio.isSquaringOff !== undefined) {
      this.isSquaringOff = portfolio.isSquaringOff;
    }
    if (portfolio.enableTrailingStop !== undefined) {
      this.enableTrailingStop = portfolio.enableTrailingStop;
    }
    if (portfolio.enableTrailingFloor !== undefined) {
      this.enableTrailingFloor = portfolio.enableTrailingFloor;
    }

    // 🛡️ FIX: Agent Blindness Bug. Implement Two-Way RAM/DB Memory Synchronization
    if (portfolio.positions) {
      const dbAssets = new Set();
      
      // 1. Actively recover missing positions into RAM
      for (const p of portfolio.positions) {
        if (p.status === 'open') {
          dbAssets.add(p.asset);
          if (!this.openPositions.has(p.asset)) {
            this.logger.info(`🔄 Recovering Missing Position ${p.asset} into TrailingAgent memory`);
            this.openPositions.set(p.asset, {
              asset: p.asset,
              side: p.side,
              quantity: p.quantity,
              entryPrice: p.entryPrice,
              highestNetPnl: p.highestProfitMilestone || 0,
              trailingAtrMult: p.trailingAtrMult,
              entryAtr: p.entryAtr
            });
          } else {
            // Sync partial fill shrinkages to prevent calculation skew
            const cached = this.openPositions.get(p.asset);
            if (cached.quantity !== p.quantity && cached.quantity > 0) {
              // Proportionally shrink highest peak to prevent instant fake-out trigger
              cached.highestNetPnl = cached.highestNetPnl * (p.quantity / cached.quantity);
            }
            cached.quantity = p.quantity;
            cached.entryPrice = p.entryPrice;
          }
        }
      }

      // 2. Sweep Ghost Positions from RAM
      for (const asset of this.openPositions.keys()) {
        if (!dbAssets.has(asset)) {
          this.logger.info(`🧹 Sweeping Ghost Position ${asset} from TrailingAgent memory`);
          this.openPositions.delete(asset);
        }
      }
    }
  }

  async handleMarketTick(tickPayload) {
    if (this.isSquaringOff) return;
    if (this.openPositions.size === 0) return;

    let ticks = [];
    if (tickPayload.type === 'bulk_ticks') {
      ticks = tickPayload.ticks;
    } else if (tickPayload.type === 'snapshot') {
      return; 
    } else {
      ticks = [tickPayload]; // Legacy fallback
    }

    for (const tick of ticks) {
      const symbol = tick.asset || tick.symbol;
      if (!symbol) continue;

      const pos = this.openPositions.get(symbol);
      if (!pos) continue;

      const currentPrice = tick.price;
      const unrealizedPnl = pos.side === 'long'
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity;

    const openFee = (pos.entryPrice * pos.quantity) * this.futuresMakerFeeRate;
    const closeFee = (currentPrice * pos.quantity) * this.futuresMakerFeeRate;
    const netPnl = unrealizedPnl - openFee - closeFee;

    // Update highest net PnL milestone and persist periodically
    if (netPnl > pos.highestNetPnl) {
      pos.highestNetPnl = netPnl;
      const now = Date.now();
      // Throttle DB updates to once every 10 seconds per asset to avoid DB spam
      if (!pos.lastMilestoneSave || now - pos.lastMilestoneSave > 10000) {
        pos.lastMilestoneSave = now;
        Portfolio.updateOne(
          { userId: 'system', 'positions.asset': pos.asset, 'positions.status': 'open' },
          { $set: { 'positions.$.highestProfitMilestone': netPnl } }
        ).catch(err => this.logger.error(`Failed to persist milestone for ${pos.asset}: ${err.message}`));
      }
    }

    // Check trailing stop logic (Skip execution if feature is disabled by UI)
    if (!this.enableTrailingStop) continue;
    
    let trailingStep = pos.trailingAtrMult ? (pos.trailingAtrMult * pos.entryAtr * pos.quantity) : this.trailingStopUsd;
    let minimumWakeUpFloor = 0;
    
    if (this.enableTrailingFloor) {
      minimumWakeUpFloor = pos.trailingAtrMult ? Math.max((pos.entryAtr * pos.quantity), 0.10) : this.trailingStopMinFloorUsd;
    }
    
    if (!trailingStep || trailingStep <= 0) continue; 
    const usedAlertLabel = pos.trailingAtrMult ? `${pos.trailingAtrMult.toFixed(1)}x ATR ($${trailingStep.toFixed(2)})` : `Static $${trailingStep.toFixed(2)}`;

    if (pos.highestNetPnl >= minimumWakeUpFloor) {
      // Lock in the peak minus the trailing step. 
      // Phase 4e: Instead of Break-Even ($0.01), aggressively lock in 50% of the Wake Up Floor.
      const lockedInFloor = Math.max(minimumWakeUpFloor * 0.50, pos.highestNetPnl - trailingStep);

      if (netPnl <= lockedInFloor) {
        if (pos.isExiting && (Date.now() - pos.exitTime < 60000)) continue; // Wait 60 seconds before retrying to prevent duplicate signal overlap while EMS is retrying

        this.logger.info(`📉 Trailing SL Triggered for ${pos.asset}: Peak $${pos.highestNetPnl.toFixed(2)} → Closed @ ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`);
        
        // Mark as exiting but do not delete until EMS confirms EXIT
        pos.isExiting = true;
        pos.exitTime = Date.now();

        // Fire programmatic Telegram alert (delegated to EMS)
        const trailingAlertMsg = `🎯 **AI Trailing Stop Triggered!**\n**Asset:** ${pos.asset}\n**Peak Profit Reached:** +$${pos.highestNetPnl.toFixed(2)}\n**Trailing Cushion Used:** ${usedAlertLabel}\n**Result:** Successfully secured +$${netPnl.toFixed(2)} Net PnL.`;

        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: pos.asset,
          side: pos.side,
          quantity: pos.quantity,
          currentPrice: currentPrice,
          forceMarket: true, // Emergency risk execution MUST be instant
          reason: `Trailing Stop-Loss Triggered (Peak $${pos.highestNetPnl.toFixed(2)} → Closed @ ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} Net PnL)`,
          autonomousAlert: trailingAlertMsg
        });
      }
    }
    }
  }

  async execute() {}
}
