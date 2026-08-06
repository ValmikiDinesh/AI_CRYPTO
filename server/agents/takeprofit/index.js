import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, CHANNELS } from '../../config/redis.js';
import { placeTriggerOrder } from '../../services/exchangeService.js';

export default class TakeProfitAgent extends BaseAgent {
  constructor() {
    super('takeprofit');
    this.virtualTakeProfits = new Map();
  }

  async initialize() {
    this.logger.info('Initializing Take Profit Service...');
    
    // Boot-time trigger verification for existing open positions
    try {
      const { default: Portfolio } = await import('../../models/Portfolio.js');
      const { getExchange } = await import('../../services/exchangeService.js');
      const exchange = getExchange();
      
      const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
        if (portfolio && portfolio.positions) {
          for (const pos of portfolio.positions) {
            if (pos.status === 'open' && pos.takeProfit && pos.takeProfit > 0) {
              if (pos.hasVirtualTakeProfit) {
                this.logger.info(`🔍 Boot-time verification: ${pos.asset} has a Virtual Take Profit at ${pos.takeProfit}. Loading into memory...`);
                this.virtualTakeProfits.set(pos.asset, pos);
                continue;
              }
              try {
                const openOrders = await exchange.fetchOpenOrders(pos.asset);
                const hasTPMarket = openOrders.some(o => o.type === 'take_profit_market' || o.raw?.order_type === 'TAKE_PROFIT_MARKET');
                if (!hasTPMarket) {
                  this.logger.warn(`🔍 Boot-time verification: Missing Take Profit for ${pos.asset}. Placing now...`);
                  await this.handleTradeExecution({
                    type: 'ENTRY',
                    asset: pos.asset,
                    side: pos.side,
                    quantity: pos.quantity,
                    price: pos.entryPrice,
                    takeProfit: pos.takeProfit
                  });
                }
              } catch (fetchErr) {
                this.logger.warn(`Could not verify open triggers for ${pos.asset}: ${fetchErr.message}`);
              }
            }
          }
        }
    } catch (err) {
      this.logger.error(`Take Profit boot-time verification failed: ${err.message}`);
    }

    await subscribeToChannel(CHANNELS.TRADE_EXECUTIONS, this.handleTradeExecution.bind(this));
    await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, this.handlePortfolioUpdate.bind(this));
    await subscribeToChannel(CHANNELS.MARKET_DATA, this.handleMarketTick.bind(this));
  }

  handlePortfolioUpdate(portfolio) {
    if (portfolio.positions) {
      const dbAssets = new Set();
      
      for (const p of portfolio.positions) {
        if (p.status === 'open' && p.hasVirtualTakeProfit) {
          dbAssets.add(p.asset);
          if (!this.virtualTakeProfits.has(p.asset)) {
            this.logger.info(`🔄 Recovering Virtual Take Profit for ${p.asset} into memory...`);
            this.virtualTakeProfits.set(p.asset, p);
          } else {
            const cached = this.virtualTakeProfits.get(p.asset);
            cached.takeProfit = p.takeProfit;
            cached.quantity = p.quantity;
          }
        }
      }
      
      for (const asset of this.virtualTakeProfits.keys()) {
        if (!dbAssets.has(asset)) {
          this.logger.info(`🧹 Removing ${asset} from Virtual Take Profit memory (position closed or no longer virtual).`);
          this.virtualTakeProfits.delete(asset);
        }
      }
    }
  }

  async handleMarketTick(tickPayload) {
    if (this.virtualTakeProfits.size === 0) return;

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

      const pos = this.virtualTakeProfits.get(symbol);
      if (!pos || !pos.takeProfit) continue;

      const currentPrice = tick.price;
      let tpTriggered = false;

      if (pos.side === 'long' && currentPrice >= pos.takeProfit) tpTriggered = true;
      if (pos.side === 'short' && currentPrice <= pos.takeProfit) tpTriggered = true;

      if (tpTriggered) {
        if (pos.isExiting && (Date.now() - pos.exitTime < 60000)) continue; 

        this.logger.error(`🎯 VIRTUAL TAKE PROFIT TRIGGERED for ${pos.asset} at ${currentPrice}! (Target: ${pos.takeProfit}). Firing Exit!`);
        
        pos.isExiting = true;
        pos.exitTime = Date.now();

        const { publishEvent } = await import('../../config/redis.js');
        await publishEvent(CHANNELS.EXIT_REQUESTS, {
          asset: pos.asset,
          side: pos.side,
          quantity: pos.quantity,
          currentPrice: currentPrice,
          forceMarket: true, 
          reason: `Virtual Take Profit Triggered (Crossed ${pos.takeProfit})`,
          autonomousAlert: `🎯 **Virtual Take Profit Triggered!**\n**Asset:** ${pos.asset}\n**Target:** ${pos.takeProfit}\n**Result:** Exit successfully executed.`
        });
      }
    }
  }

  async handleTradeExecution(payload) {
    if (payload.type !== 'ENTRY') return;

    const { asset, side, quantity, price, takeProfit } = payload;
    
    if (!takeProfit || takeProfit <= 0) {
      this.logger.debug(`No hard Take Profit defined for ${asset} entry. Skipping native trigger placement.`);
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
        this.logger.info(`Take Profit Service placing native TAKE_PROFIT_MARKET for ${asset} at ${takeProfit} (Attempt ${attempt}/${maxRetries})`);
        
        const order = await placeTriggerOrder(asset, exitSide, quantity, takeProfit, 'TAKE_PROFIT_MARKET');
        
        if (order && order.id) {
          this.logger.info(`✅ Successfully placed native Take Profit trigger order for ${asset} (ID: ${order.id})`);
          success = true;
        } else {
          throw new Error('Order returned successfully but missing ID');
        }
      } catch (err) {
        if (err.message && err.message.toLowerCase().includes('already exists')) {
          this.logger.info(`✅ Native Take Profit already exists for ${asset}. Treating as success.`);
          success = true;
          break;
        }

        this.logger.warn(`Failed to place native Take Profit order for ${asset} (Attempt ${attempt}): ${err.message}`);
        if (attempt >= maxRetries) {
          this.logger.error(`⚠️ CoinSwitch rejected native Take Profit for ${asset} 3 times. Activating internal Virtual Take Profit as fallback!`);
          
          try {
            const { default: Trade } = await import('../../models/Trade.js');
            const { default: Portfolio } = await import('../../models/Portfolio.js');
            
            this.virtualTakeProfits.set(asset, {
              asset,
              side,
              quantity,
              entryPrice: price,
              takeProfit,
              hasVirtualTakeProfit: true
            });

            await Trade.updateOne({ asset, status: 'open' }, { $set: { hasVirtualTakeProfit: true } });
            await Portfolio.updateOne(
              { userId: 'system', "positions.asset": asset, "positions.status": "open" },
              { $set: { "positions.$.hasVirtualTakeProfit": true } }
            );
          } catch (dbErr) {
            this.logger.error(`Failed to activate Virtual Take Profit fallback for ${asset}: ${dbErr.message}`);
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
