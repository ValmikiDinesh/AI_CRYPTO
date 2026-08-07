import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, publishEvent, CHANNELS } from '../../config/redis.js';
import Portfolio from '../../models/Portfolio.js';

export default class ScalpProfitAgent extends BaseAgent {
  constructor() {
    super('scalp');
    this.openPositions = new Map();
    this.enableDynamicScalp = false;
    this.fixedScalpTargetUsd = 0;
    this.fixedScalpStopLossUsd = 0;
    this.futuresMakerFeeRate = 0.0005; // 0.05% Taker fee on CoinSwitch
    this.isSquaringOff = false;
  }

  async initialize() {
    this.logger.info('Initializing Scalp Profit Service...');
    
    // Load initial state
    const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
    if (portfolio) {
      this.enableDynamicScalp = portfolio.enableDynamicScalp || false;
      this.fixedScalpTargetUsd = portfolio.fixedScalpTargetUsd || 0;
      this.fixedScalpStopLossUsd = portfolio.fixedScalpStopLossUsd || 0;
      this.isSquaringOff = portfolio.isSquaringOff;
      if (portfolio.positions) {
        portfolio.positions.forEach(p => {
          if (p.status === 'open') {
            this.openPositions.set(p.asset, p);
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
    if (portfolio.enableDynamicScalp !== undefined) {
      this.enableDynamicScalp = portfolio.enableDynamicScalp;
    }
    if (portfolio.fixedScalpTargetUsd !== undefined) {
      this.fixedScalpTargetUsd = portfolio.fixedScalpTargetUsd;
    }
    if (portfolio.fixedScalpStopLossUsd !== undefined) {
      this.fixedScalpStopLossUsd = portfolio.fixedScalpStopLossUsd;
    }
    if (portfolio.isSquaringOff !== undefined) {
      this.isSquaringOff = portfolio.isSquaringOff;
    }

    // 🛡️ Round 94: FIX Agent Blindness - Two-Way RAM/DB Memory Synchronization
    if (portfolio.positions) {
      const dbAssets = new Set();
      
      // 1. Actively recover missing positions into RAM
      for (const p of portfolio.positions) {
        if (p.status === 'open') {
          dbAssets.add(p.asset);
          if (!this.openPositions.has(p.asset)) {
            this.logger.info(`🔄 Recovering Missing Position ${p.asset} into ScalpAgent memory`);
            this.openPositions.set(p.asset, {
              asset: p.asset,
              side: p.side,
              quantity: p.quantity,
              entryPrice: p.entryPrice,
            });
          } else {
            // Keep quantity in sync to prevent partial-fill ghost calculations
            const cached = this.openPositions.get(p.asset);
            cached.quantity = p.quantity;
            cached.entryPrice = p.entryPrice;
          }
        }
      }
      
      // 2. Sweep Ghost Positions from RAM
      for (const asset of this.openPositions.keys()) {
        if (!dbAssets.has(asset)) {
          this.logger.info(`🧹 Sweeping Ghost Position ${asset} from ScalpAgent memory`);
          this.openPositions.delete(asset);
        }
      }
    }
  }

  async handleMarketTick(tickPayload) {
    if (!this.enableDynamicScalp) return;
    if (this.isSquaringOff) return; // Let Sweep service handle exits if squaring off
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

      if (pos.activeStrategy === 'trend_sniper') continue; // 🛡️ GUARD: Only apply to HFT Scalping trades

      // Determine target: Fixed USD takes priority, otherwise fallback to Dynamic ATR
      let target = 0;
      if (this.fixedScalpTargetUsd > 0) {
        target = this.fixedScalpTargetUsd;
      } else {
        if (!pos.entryAtr) continue; 
        target = pos.entryAtr * pos.quantity;
      }
      if (target <= 0) continue;

      if (netPnl >= target) {
        if (pos.isExiting && (Date.now() - pos.exitTime < 60000)) continue; // Wait 60 seconds before retrying to prevent EMS collision

        this.logger.info(`⚡ Scalp Target Reached for ${pos.asset}: +$${netPnl.toFixed(2)} Net PnL (Dynamic Target: $${target.toFixed(2)})`);
        
        // Mark as exiting but do not delete until EMS confirms EXIT
        pos.isExiting = true;
        pos.exitTime = Date.now();

        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: pos.asset,
          side: pos.side,
          quantity: pos.quantity,
          currentPrice: currentPrice,
          forceMarket: true,
          reason: `Scalp Profit Target Reached (+$${netPnl.toFixed(2)} net)`
        });
      } else if (this.fixedScalpStopLossUsd > 0 && netPnl <= -this.fixedScalpStopLossUsd) {
        if (pos.isExiting && (Date.now() - pos.exitTime < 60000)) continue; // Wait 60 seconds before retrying to prevent EMS collision

        this.logger.info(`🛑 Scalp Stop Loss Reached for ${pos.asset}: -$${Math.abs(netPnl).toFixed(2)} Net PnL (Stop Loss: -$${this.fixedScalpStopLossUsd.toFixed(2)})`);
        
        // Mark as exiting but do not delete until EMS confirms EXIT
        pos.isExiting = true;
        pos.exitTime = Date.now();

        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: pos.asset,
          side: pos.side,
          quantity: pos.quantity,
          currentPrice: currentPrice,
          forceMarket: true,
          reason: `Scalp Fixed Stop Loss Triggered (-$${Math.abs(netPnl).toFixed(2)} net)`
        });
      }
    }
  }

  async execute() {}
}
