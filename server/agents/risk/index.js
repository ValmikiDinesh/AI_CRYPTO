import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, RISK, ACTIONS, CORE_ASSETS, MEME_ASSETS, RECOMMENDED_ASSETS } from '../../config/constants.js';
import { publishEvent, subscribeToChannel, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, escapeHtml } from '../../services/telegramService.js';
import RiskEvent from '../../models/RiskEvent.js';
import Portfolio from '../../models/Portfolio.js';
import Trade from '../../models/Trade.js';
import { getSystemWarmingUp } from '../../config/bootState.js';


/**
 * Risk Management Agent — MOST IMPORTANT COMPONENT
 * - Enforces stop-loss & take-profit.
 * - Limits leverage and exposure.
 * - Prevents overtrading.
 * - Max daily loss and drawdown protection.
 * - Emergency shutdown during dangerous volatility.
 */
export default class RiskAgent extends BaseAgent {
  constructor(marketAgent) {
    super(AGENT_NAMES.RISK);
    this.marketAgent = marketAgent;
    this.dailyTradeCount = 0;
    this.maxDailyTrades = RISK.MAX_DAILY_TRADES;
    this.lastResetDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
    this.emergencyActive = false;
    this.lastAlertTimes = {};
    this.assetLossCooldowns = new Map();
  }

  setLossCooldown(asset, durationMs = 15 * 60 * 1000) {
    if (!asset) return;
    const cleanAsset = asset.replace('/', '').replace(':USDT', '').toUpperCase();
    const expiry = Date.now() + durationMs;
    this.assetLossCooldowns.set(cleanAsset, expiry);
    this.logger.info(`🧊 [LOSS COOLING PERIOD] ${cleanAsset} set to 15-minute cooling period until ${new Date(expiry).toISOString()}`);
  }

  async initialize() {
    await super.initialize();
    
    try {
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
      const startOfToday = new Date(`${todayStr}T00:00:00.000+05:30`);
      const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      
      const filter = {
        createdAt: { $gte: startOfToday, $lt: endOfToday },
        status: { $in: ['open', 'closed'] }
      };
      filter.exchangeOrderId = { $exists: true, $ne: null };
      filter.type = 'live';

      const count = await Trade.countDocuments(filter);
      this.dailyTradeCount = count;
      this.logger.info(`Recovered daily trade count from database: ${count} confirmed live trades executed today (IST).`);
      

      const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
      if (portfolio && portfolio.maxDailyTrades !== undefined) {
        this.maxDailyTrades = portfolio.maxDailyTrades;
      }

      await subscribeToChannel(CHANNELS.TRADE_EXECUTIONS, async (payload) => {
        if (payload.type === 'ENTRY') {
          const trade = await Trade.findById(payload.tradeId);
          if (trade && trade.exchangeOrderId && !trade.exchangeOrderId.startsWith('mock_')) {
            this.dailyTradeCount++;
            this.logger.info(`Incremented daily trade count via Event Bus: ${this.dailyTradeCount}/${this.maxDailyTrades}`);
          }
        }
      });

      await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, this.handlePortfolioUpdate.bind(this));

    } catch (err) {
      this.logger.error(`Failed to recover daily trade count on startup: ${err.message}`);
    }
  }

  handlePortfolioUpdate(portfolio) {
    if (portfolio.maxDailyTrades !== undefined) {
      this.maxDailyTrades = portfolio.maxDailyTrades;
      this.logger.info(`🔄 RiskAgent dynamically updated Max Daily Trades to: ${this.maxDailyTrades}`);
    }
  }

  async execute() {
    const now = Date.now();
    // Reset daily counters at midnight in IST timezone
    const today = new Date(now + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.dailyTradeCount = 0;
      this.lastResetDate = today;
      this.logger.info('Daily trade counter reset (IST)');

      // Also reset daily loss on portfolios, and unlock the isSquaringOff state
      await Portfolio.updateMany({}, { $set: { dailyLossToday: 0, isSquaringOff: false } });
    }

    // Check all portfolios for risk breaches every 10 seconds (prevents DB query spamming)
    if (!this._lastRiskCheck || (now - this._lastRiskCheck) >= 10000) {
      this._lastRiskCheck = now;
      const portfolios = await Portfolio.find({}).lean();
      for (const portfolio of portfolios) {
        await this.checkPortfolioRisk(portfolio);
      }
    }
  }

  /**
   * Validate a proposed trade signal against risk rules.
   * Returns { approved, reason } — the Execution Agent must call this before placing orders.
   */
  async validateTrade(signal, portfolio) {
    const checks = [];

    // 0. System Warmup Cooldown Check
    if (getSystemWarmingUp()) {
      return this.reject('Server is restarting / warming up asset feeds — system in cooling period', 'system_warmup_cooldown', signal);
    }

    // 0. Emergency stop check
    if (this.emergencyActive) {
      return this.reject('Emergency stop is active — all trading halted', 'emergency_shutdown', signal);
    }

    // 0.6. 15-Minute Asset Loss Cooldown Check
    const cleanAsset = signal.asset ? signal.asset.replace('/', '').replace(':USDT', '').toUpperCase() : '';
    const now = Date.now();
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;

    // Check fast in-memory map
    const cooloffExpiry = this.assetLossCooldowns.get(cleanAsset);
    if (cooloffExpiry && now < cooloffExpiry) {
      const minutesLeft = Math.ceil((cooloffExpiry - now) / 60000);
      return this.reject(
        `Asset ${cleanAsset} is in a 15-minute cooling period after a recent trade closed in loss (${minutesLeft}m remaining)`,
        'asset_loss_cooldown',
        signal
      );
    }

    // Fallback DB check for trades closed in loss within 15 mins (persists across restarts)
    try {
      const fifteenMinAgo = new Date(now - FIFTEEN_MIN_MS);
      const recentLossTrade = await Trade.findOne({
        asset: { $in: [cleanAsset, `${cleanAsset}USDT`, signal.asset] },
        status: 'closed',
        closedAt: { $gte: fifteenMinAgo },
      }).sort({ closedAt: -1 }).lean();

      if (recentLossTrade) {
        const netPnl = (recentLossTrade.pnl || 0) - (recentLossTrade.fees || 0);
        if (netPnl < 0) {
          const closedTime = new Date(recentLossTrade.closedAt).getTime();
          const remainingMs = (closedTime + FIFTEEN_MIN_MS) - now;
          if (remainingMs > 0) {
            this.assetLossCooldowns.set(cleanAsset, closedTime + FIFTEEN_MIN_MS);
            const minutesLeft = Math.ceil(remainingMs / 60000);
            return this.reject(
              `Asset ${cleanAsset} is in a 15-minute cooling period after a trade closed in loss (-$${Math.abs(netPnl).toFixed(2)}, ${minutesLeft}m remaining)`,
              'asset_loss_cooldown',
              signal
            );
          }
        }
      }
    } catch (dbErr) {
      this.logger.warn(`Could not verify DB loss cooldown for ${cleanAsset}: ${dbErr.message}`);
    }

    // 1.5. Basket square-off check
    if (portfolio && portfolio.isSquaringOff) {
      return this.reject('Portfolio is squaring off all positions after reaching profit target', 'portfolio_square_off', signal);
    }

    // 1.6. Asset Disabled check
    if (portfolio) {
      const manuallyDisabled = portfolio.manuallyDisabledAssets || [];
      const autoIgnored = portfolio.autoIgnoredAssets || [];
      if (manuallyDisabled.includes(signal.asset)) {
        return this.reject(`Asset ${signal.asset} is manually disabled by the user`, 'asset_disabled', signal);
      }
      if (autoIgnored.includes(signal.asset)) {
        return this.reject(`Asset ${signal.asset} is auto-ignored due to pending exchange exit order`, 'asset_ignored_closing', signal);
      }
    }

    // 2. Confidence threshold
    const activeStrategy = portfolio?.activeStrategy || 'trend_sniper';
    const dynamicConfidenceThreshold = portfolio?.strategySettings?.[activeStrategy]?.confidenceThreshold || RISK.MIN_CONFIDENCE_THRESHOLD;

    if (signal.confidence < dynamicConfidenceThreshold) {
      return this.reject(
        `Confidence ${signal.confidence.toFixed(2)} below threshold ${dynamicConfidenceThreshold}`,
        'low_confidence',
        signal
      );
    }

    // 2.5. 1-Hour Macro Trend Alignment Filter (Enforce Trend-Following Strategy)
    const candles = this.marketAgent ? this.marketAgent.getCandles(signal.asset) : null;
    if (candles && candles.length >= 12) {
      const currentClose = candles[candles.length - 1].close;
      const close1hAgo = candles[candles.length - 12].close; // 12 candles * 5m = 60m (1 hour)
      const priceChange1hPct = ((currentClose - close1hAgo) / close1hAgo) * 100;

      const isBuyAction = signal.action === ACTIONS.BUY || signal.action === 'BUY' || signal.side === 'long';
      const isSellAction = signal.action === ACTIONS.SELL || signal.action === 'SELL' || signal.side === 'short';

      // Relax macro trend check for rapid micro-scalping (only block extreme 15%+ crashes/surges)
      if (isBuyAction && priceChange1hPct < -15.0) {
        return this.reject(
          `1-Hour macro trend is severely crashing (${priceChange1hPct.toFixed(2)}%) for ${signal.asset} — extreme crash BUY rejected`,
          'trend_alignment_mismatch',
          signal
        );
      } else if (isSellAction && priceChange1hPct > 15.0) {
        return this.reject(
          `1-Hour macro trend is severely surging (+${priceChange1hPct.toFixed(2)}%) for ${signal.asset} — extreme surge SELL rejected`,
          'trend_alignment_mismatch',
          signal
        );
      }
    }


    // 3. Max risk per trade (increased to 16% to support aggressive Kelly allocations)
    const positionPct = parseFloat(signal.positionSize) / 100;
    if (positionPct > 0.16) { 
      return this.reject(
        `Position size ${signal.positionSize} exceeds max allowed`,
        'max_trade_risk',
        signal
      );
    }

    // 4. Daily loss limit
    if (portfolio) {
      if (portfolio.dailyLossToday < 0) {
        const startingCapital = portfolio.totalBalance - portfolio.dailyLossToday;
        if (startingCapital > 0) {
          const dailyLossPct = Math.abs(portfolio.dailyLossToday) / startingCapital;
          const maxLossLimitDecimal = portfolio.maxDailyLossPct !== undefined ? (portfolio.maxDailyLossPct / 100) : RISK.MAX_DAILY_LOSS;
          
          if (dailyLossPct >= maxLossLimitDecimal) {
            return this.reject(
              `Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds limit ${(maxLossLimitDecimal * 100).toFixed(1)}% of start-of-day capital ($${startingCapital.toFixed(2)})`,
              'daily_loss_limit',
              signal
            );
          }
        }
      }

      // 5.5. Duplicate position check
      // 🛡️ FIX: Prevent Limit Order Pyramiding by factoring in pending 'oms_approved' orders
      const existingOpenTrade = await Trade.findOne({ 
        asset: signal.asset, 
        status: { $in: ['open', 'oms_approved'] } 
      });
      const hasOpenPosition = portfolio.positions?.some((p) => p && p.asset === signal.asset && p.status === 'open');
      if (hasOpenPosition || existingOpenTrade) {
        return this.reject(
          `Position or Limit Order already active for ${signal.asset}`,
          'duplicate_position',
          signal
        );
      }

      // 6. Max open positions checks
      const openPositionsList = portfolio.positions?.filter((p) => p.status === 'open') || [];
      
      // 🛡️ FIX: Ensure pending Limit Orders count toward the MAX_OPEN_POSITIONS ceiling!
      const pendingOrdersCount = await Trade.countDocuments({ status: 'oms_approved' });
      const totalOpen = openPositionsList.length + pendingOrdersCount;

      if (totalOpen >= RISK.MAX_OPEN_POSITIONS) {
        return this.reject(
          `${totalOpen} active trades/orders — max is ${RISK.MAX_OPEN_POSITIONS}`,
          'position_limit',
          signal
        );
      }

      // Check category-specific limits
      const isCore = CORE_ASSETS.includes(signal.asset);
      const isMeme = MEME_ASSETS.includes(signal.asset);
      const isRecommended = RECOMMENDED_ASSETS.includes(signal.asset);

      if (isCore) {
        const coreOpen = openPositionsList.filter((p) => CORE_ASSETS.includes(p.asset)).length;
        if (coreOpen >= RISK.MAX_CORE_POSITIONS) {
          return this.reject(
            `${coreOpen} open Core Crypto positions — max is ${RISK.MAX_CORE_POSITIONS}`,
            'position_limit',
            signal
          );
        }
      } else if (isMeme) {
        const memeOpen = openPositionsList.filter((p) => MEME_ASSETS.includes(p.asset)).length;
        if (memeOpen >= RISK.MAX_MEME_POSITIONS) {
          return this.reject(
            `${memeOpen} open Meme Coin positions — max is ${RISK.MAX_MEME_POSITIONS}`,
            'position_limit',
            signal
          );
        }
      } else if (isRecommended) {
        const recOpen = openPositionsList.filter((p) => RECOMMENDED_ASSETS.includes(p.asset)).length;
        if (recOpen >= RISK.MAX_RECOMMENDED_POSITIONS) {
          return this.reject(
            `${recOpen} open Recommended positions — max is ${RISK.MAX_RECOMMENDED_POSITIONS}`,
            'position_limit',
            signal
          );
        }
      }
    }

    // 7. Overtrading check
    if (this.dailyTradeCount >= this.maxDailyTrades) {
      return this.reject(
        `${this.dailyTradeCount} trades today — max is ${this.maxDailyTrades}`,
        'overtrading',
        signal
      );
    }

    // 8. Volatility check
    const price = this.marketAgent.getPrice(signal.asset);
    if (signal.indicators?.atr && price) {
      const volatilityPct = signal.indicators.atr / price;
      if (volatilityPct > RISK.EMERGENCY_VOLATILITY_THRESHOLD) {
        await this.triggerEmergency(
          `Extreme volatility detected for ${signal.asset}: ${(volatilityPct * 100).toFixed(1)}%`
        );
        return this.reject('Emergency shutdown — extreme volatility', 'high_volatility', signal);
      }
    }

    // 9. Risk score check
    if (signal.riskScore > 0.8) {
      return this.reject(
        `Risk score ${signal.riskScore.toFixed(2)} too high`,
        'high_risk_score',
        signal
      );
    }

    // All checks passed
    return { approved: true, reason: 'All risk checks passed' };
  }

  incrementDailyTradeCount(trade) {
    const orderId = trade?.exchangeOrderId || (typeof trade === 'string' ? trade : null);
    if (!orderId || orderId.startsWith('mock_')) {
      return;
    }
    this.dailyTradeCount++;
    this.logger.info(`Incremented daily trade count for confirmed trade: ${this.dailyTradeCount}/${this.maxDailyTrades}`);
  }

  async reject(reason, type, signal) {
    this.logger.warn(`TRADE REJECTED [${signal.asset}]: ${reason}`);

    await RiskEvent.create({
      type,
      severity: type === 'emergency_shutdown' ? 'emergency' : 'warning',
      asset: signal.asset,
      message: reason,
      actionTaken: 'trade_blocked',
    });

    // Notify Telegram (unless it is duplicate position, overtrading, or position limit to prevent spamming channel every cycle)
    // We also rate-limit alerts for drawdown_limit and daily_loss_limit to prevent spamming Telegram every cycle.
    const ignoredAlertTypes = ['duplicate_position', 'overtrading', 'position_limit'];
    const now = Date.now();
    const COOL_DOWN_MS = 15 * 60 * 1000; // 15-minute cooldown per alert type

    if (!ignoredAlertTypes.includes(type)) {
      const lastAlertTime = this.lastAlertTimes[type] || 0;
      if (now - lastAlertTime >= COOL_DOWN_MS) {
        this.lastAlertTimes[type] = now;
        await sendTelegramMessage(
          `⚠️ <b>Risk Alert [${signal.asset.replace('USDT', '')}]</b>\n` +
          `<b>Action Taken</b>: Trade Blocked\n` +
          `<b>Violation</b>: ${type.toUpperCase().replace(/_/g, ' ')}\n` +
          `<b>Reason</b>: ${escapeHtml(reason)}`
        );
      }
    }

    await publishEvent(CHANNELS.RISK_EVENTS, {
      type,
      asset: signal.asset,
      message: reason,
      severity: 'warning',
    });

    return { approved: false, reason };
  }

  async checkPortfolioRisk(portfolio) {
    if (portfolio && portfolio.dailyLossToday < 0) {
      const startingCapital = portfolio.totalBalance - portfolio.dailyLossToday;
      if (startingCapital > 0) {
        const dailyLossPct = Math.abs(portfolio.dailyLossToday) / startingCapital;
        const maxLossLimitDecimal = portfolio.maxDailyLossPct !== undefined ? (portfolio.maxDailyLossPct / 100) : RISK.MAX_DAILY_LOSS;
        
        const hasOpenPositions = portfolio.positions && portfolio.positions.some(p => p.status === 'open');

        if (dailyLossPct >= maxLossLimitDecimal) {
          if (hasOpenPositions && !portfolio.isSquaringOff) {
            this.logger.error(`🚨 DAILY LOSS LIMIT BREACHED: ${(dailyLossPct * 100).toFixed(1)}% >= ${(maxLossLimitDecimal * 100).toFixed(1)}%. Initiating hard shutdown!`);
          
          await Portfolio.updateOne(
            { userId: portfolio.userId },
            { $set: { isSquaringOff: true, tradingPaused: true } }
          );

          await RiskEvent.create({
            type: 'daily_loss_limit',
            severity: 'critical',
            message: `HARD SHUTDOWN: Daily loss at ${(dailyLossPct * 100).toFixed(1)}% of start-of-day capital ($${startingCapital.toFixed(2)})`,
            currentValue: dailyLossPct,
            threshold: maxLossLimitDecimal,
          });
          
          if (portfolio.positions) {
            for (const pos of portfolio.positions) {
              if (pos.status === 'open') {
                await publishEvent(CHANNELS.EXIT_REQUESTS, {
                  asset: pos.asset,
                  side: pos.side,
                  quantity: pos.quantity,
                  currentPrice: pos.currentPrice,
                  forceMarket: true,
                  reason: `Daily Loss Limit Breached (${(dailyLossPct * 100).toFixed(1)}%) - Hard Shutdown`
                });
              }
            }
          }
          } else if (hasOpenPositions && portfolio.isSquaringOff) {
            // 🛡️ Round 92: Retry Loop to prevent Naked Orphan positions during EMS concurrency locks
            if (!this.lastEmergencySweep || (Date.now() - this.lastEmergencySweep > 15000)) {
              this.lastEmergencySweep = Date.now();
              this.logger.warn(`🚨 DAILY LOSS LIMIT BREACHED: Retrying Emergency Hard Shutdown for remaining open positions...`);
              if (portfolio.positions) {
                for (const pos of portfolio.positions) {
                  if (pos.status === 'open') {
                    await publishEvent(CHANNELS.EXIT_REQUESTS, {
                      asset: pos.asset,
                      side: pos.side,
                      quantity: pos.quantity,
                      currentPrice: pos.currentPrice,
                      forceMarket: true,
                      reason: `Emergency Hard Shutdown Retry (Daily Loss Limit Breached)`
                    });
                  }
                }
              }
            }
          } else if (!hasOpenPositions && !portfolio.tradingPaused) {
            // Edge case: Portfolio is flat, but daily loss limit is breached. Just ensure system remains paused.
            this.logger.error(`🚨 DAILY LOSS LIMIT BREACHED: System paused to prevent further trading.`);
            await Portfolio.updateOne(
              { userId: portfolio.userId },
              { $set: { tradingPaused: true } }
            );
          }
          
          // 🧟 Destroy all pending Zombie Limit Orders to prevent re-entry during Hard Shutdown
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
                    this.logger.warn(`🚨 [RISK] Zombie Limit Order for ${trade.asset} was PARTIALLY FILLED (${partiallyFilledQty}). Promoting to OPEN and triggering Emergency Exit!`);
                    trade.status = 'open';
                    trade.quantity = partiallyFilledQty;
                    trade.executedAt = new Date();
                    trade.reasoning = 'Partial Fill rescued during Daily Loss Hard Shutdown';
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
                      reason: `Daily Loss Hard Shutdown (Rescued Partial Fill)`
                    });
                  } else {
                    trade.status = 'failed';
                    trade.reasoning = 'Zombie Limit Order explicitly canceled due to Daily Loss Hard Shutdown';
                    await trade.save();
                  }
                }
              }
            }
          } catch (err) {
            this.logger.error(`Failed to sweep zombie orders during Hard Shutdown: ${err.message}`);
          }
        } else if (dailyLossPct >= maxLossLimitDecimal * 0.8 && !portfolio.isSquaringOff) {
          // Warning threshold
          const now = Date.now();
          if (!this.lastAlertTimes['daily_loss_warning'] || now - this.lastAlertTimes['daily_loss_warning'] >= 15 * 60 * 1000) {
            this.lastAlertTimes['daily_loss_warning'] = now;
            await RiskEvent.create({
              type: 'daily_loss_limit',
              severity: 'warning',
              message: `WARNING: Daily loss at ${(dailyLossPct * 100).toFixed(1)}% (Limit: ${(maxLossLimitDecimal * 100).toFixed(1)}%)`,
              currentValue: dailyLossPct,
              threshold: maxLossLimitDecimal,
            });
            await sendTelegramMessage(`⚠️ <b>Risk Alert</b>\nDaily Loss reaching dangerous levels: ${(dailyLossPct * 100).toFixed(1)}% / ${(maxLossLimitDecimal * 100).toFixed(1)}%`);
          }
        }
      }
    }
  }

  async triggerEmergency(reason) {
    this.emergencyActive = true;
    this.logger.error(`🚨 EMERGENCY: ${reason}`);

    await RiskEvent.create({
      type: 'emergency_shutdown',
      severity: 'emergency',
      message: reason,
      actionTaken: 'system_paused',
    });

    // Notify Telegram
    await sendTelegramMessage(
      `🚨 <b>EMERGENCY SHUTDOWN TRIGGERED!</b>\n` +
      `<b>Reason</b>: ${escapeHtml(reason)}`
    );

    await publishEvent(CHANNELS.EMERGENCY_STOP, { reason, timestamp: Date.now() });
  }

  resetEmergency() {
    this.emergencyActive = false;
    this.logger.info('Emergency stop cleared');
  }
}
