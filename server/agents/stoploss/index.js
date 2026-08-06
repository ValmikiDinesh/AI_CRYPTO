import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, CHANNELS } from '../../config/redis.js';
import { placeTriggerOrder } from '../../services/exchangeService.js';

export default class StopLossAgent extends BaseAgent {
  constructor() {
    super('stoploss');
    this.virtualStops = new Map();
  }

  async initialize() {
    this.logger.info('Initializing Stop Loss Service...');
    
    // Boot-time trigger verification for existing open positions
    try {
      const { default: Portfolio } = await import('../../models/Portfolio.js');
      const { getExchange } = await import('../../services/exchangeService.js');
      const exchange = getExchange();
      
      const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
        if (portfolio && portfolio.positions) {
          for (const pos of portfolio.positions) {
            if (pos.status === 'open' && pos.stopLoss && pos.stopLoss > 0) {
              if (pos.hasVirtualStop) {
                this.logger.info(`🔍 Boot-time verification: ${pos.asset} has a Virtual Stop Loss at ${pos.stopLoss}. Loading into memory...`);
                this.virtualStops.set(pos.asset, pos);
                continue;
              }
              try {
                const openOrders = await exchange.fetchOpenOrders(pos.asset);
                const hasStopMarket = openOrders.some(o => o.type === 'stop_market' || o.raw?.order_type === 'STOP_MARKET');
                if (!hasStopMarket) {
                  this.logger.warn(`🔍 Boot-time verification: Missing Stop Loss for ${pos.asset}. Placing now...`);
                  await this.handleTradeExecution({
                    type: 'ENTRY',
                    asset: pos.asset,
                    side: pos.side,
                    quantity: pos.quantity,
                    price: pos.entryPrice,
                    stopLoss: pos.stopLoss,
                    tradeId: pos.tradeId
                  });
                }
              } catch (fetchErr) {
                this.logger.warn(`Could not verify open triggers for ${pos.asset}: ${fetchErr.message}`);
              }
            }
          }
        }
    } catch (err) {
      this.logger.error(`Stop Loss boot-time verification failed: ${err.message}`);
    }

    await subscribeToChannel(CHANNELS.TRADE_EXECUTIONS, this.handleTradeExecution.bind(this));
    await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, this.handlePortfolioUpdate.bind(this));
    await subscribeToChannel(CHANNELS.MARKET_DATA, this.handleMarketTick.bind(this));
  }

  handlePortfolioUpdate(portfolio) {
    if (portfolio.positions) {
      const dbAssets = new Set();
      
      for (const p of portfolio.positions) {
        if (p.status === 'open' && p.hasVirtualStop) {
          dbAssets.add(p.asset);
          if (!this.virtualStops.has(p.asset)) {
            this.logger.info(`🔄 Recovering Virtual Stop Loss for ${p.asset} into memory...`);
            this.virtualStops.set(p.asset, p);
          } else {
            // Keep SL price up to date in case it was trailed or modified
            const cached = this.virtualStops.get(p.asset);
            cached.stopLoss = p.stopLoss;
            cached.quantity = p.quantity;
          }
        }
      }
      
      for (const asset of this.virtualStops.keys()) {
        if (!dbAssets.has(asset)) {
          this.logger.info(`🧹 Removing ${asset} from Virtual Stop Loss memory (position closed or no longer virtual).`);
          this.virtualStops.delete(asset);
        }
      }
    }
  }

  async handleMarketTick(tickPayload) {
    if (this.virtualStops.size === 0) return;

    let ticks = [];
    if (tickPayload.type === 'bulk_ticks') {
      ticks = tickPayload.ticks;
    } else if (tickPayload.type === 'snapshot') {
      return; 
    } else {
      ticks = [tickPayload]; 
    }

    for (const tick of ticks) {
      const symbol = tick.asset || tick.symbol;
      if (!symbol) continue;

      const pos = this.virtualStops.get(symbol);
      if (!pos || !pos.stopLoss) continue;

      const currentPrice = tick.price;
      let slTriggered = false;

      if (pos.side === 'long' && currentPrice <= pos.stopLoss) slTriggered = true;
      if (pos.side === 'short' && currentPrice >= pos.stopLoss) slTriggered = true;

      if (slTriggered) {
        if (pos.isExiting && (Date.now() - pos.exitTime < 60000)) continue; 

        this.logger.error(`🚨 VIRTUAL STOP LOSS TRIGGERED for ${pos.asset} at ${currentPrice}! (Threshold: ${pos.stopLoss}). Firing Emergency Market Exit!`);
        
        pos.isExiting = true;
        pos.exitTime = Date.now();

        const { publishEvent } = await import('../../config/redis.js');
        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: pos.asset,
          side: pos.side,
          quantity: pos.quantity,
          currentPrice: currentPrice,
          forceMarket: true, 
          reason: `Virtual Stop Loss Triggered (Crossed ${pos.stopLoss})`,
          autonomousAlert: `🚨 **Virtual Stop Loss Triggered!**\n**Asset:** ${pos.asset}\n**Threshold:** ${pos.stopLoss}\n**Result:** Emergency market exit successfully executed.`
        });
      }
    }
  }

  async handleTradeExecution(payload) {
    if (payload.type !== 'ENTRY') return;

    const { asset, side, quantity, price, stopLoss } = payload;
    
    if (!stopLoss || stopLoss <= 0) {
      this.logger.debug(`No hard Stop Loss defined for ${asset} entry. Skipping native trigger placement.`);
      return;
    }

    // The exit side is opposite of the entry side
    const exitSide = side === 'long' ? 'sell' : 'buy';
    
    let attempt = 0;
    const maxRetries = 3;
    let success = false;

    while (attempt < maxRetries && !success) {
      try {
        attempt++;
        this.logger.info(`Stop Loss Service placing native STOP_MARKET for ${asset} at ${stopLoss} (Attempt ${attempt}/${maxRetries})`);
        
        const order = await placeTriggerOrder(asset, exitSide, quantity, stopLoss, 'STOP_MARKET');
        
        if (order && order.id) {
          this.logger.info(`✅ Successfully placed native Stop Loss trigger order for ${asset} (ID: ${order.id})`);
          success = true;
        } else {
          throw new Error('Order returned successfully but missing ID');
        }
      } catch (err) {
        if (err.message && err.message.toLowerCase().includes('already exists')) {
          this.logger.info(`✅ Native Stop Loss already exists for ${asset}. Treating as success.`);
          success = true;
          break;
        }

        this.logger.warn(`Failed to place native Stop Loss order for ${asset} (Attempt ${attempt}): ${err.message}`);
        if (attempt >= maxRetries) {
          this.logger.error(`⚠️ CoinSwitch rejected native Stop Loss for ${asset} 3 times. Activating internal Virtual Stop Loss as fallback!`);
          
          // 🛡️ Activate Virtual Stop Loss Fallback
          try {
            const { default: Trade } = await import('../../models/Trade.js');
            const { default: Portfolio } = await import('../../models/Portfolio.js');
            
            // Note: Since this payload might just come from redis, we use the payload data
            this.virtualStops.set(asset, {
              asset,
              side,
              quantity,
              entryPrice: price,
              stopLoss,
              hasVirtualStop: true
            });

            await Trade.updateOne({ asset, status: 'open' }, { $set: { hasVirtualStop: true } });
            await Portfolio.updateOne(
              { userId: 'system', "positions.asset": asset, "positions.status": "open" },
              { $set: { "positions.$.hasVirtualStop": true } }
            );
          } catch (dbErr) {
            this.logger.error(`Failed to activate Virtual Stop Loss fallback for ${asset}: ${dbErr.message}`);
          }
        } else {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }

  async execute() {
    // Purely event-driven
  }
}
