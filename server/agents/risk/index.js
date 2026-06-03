import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, RISK, ACTIONS, CORE_ASSETS, MEME_ASSETS, RECOMMENDED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, escapeHtml } from '../../services/telegramService.js';
import RiskEvent from '../../models/RiskEvent.js';
import Portfolio from '../../models/Portfolio.js';
import Trade from '../../models/Trade.js';
import { EMA } from 'technicalindicators';
import { fetchCandles } from '../../services/exchangeService.js';

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
  }

  async initialize() {
    await super.initialize();
    
    try {
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
      const startOfToday = new Date(`${todayStr}T00:00:00.000+05:30`);
      const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      
      const count = await Trade.countDocuments({
        createdAt: { $gte: startOfToday, $lt: endOfToday },
        status: { $in: ['open', 'closed'] }
      });
      this.dailyTradeCount = count;
      this.logger.info(`Recovered daily trade count from database: ${count} successful trades placed today (IST).`);
    } catch (err) {
      this.logger.error(`Failed to recover daily trade count on startup: ${err.message}`);
    }
  }

  async execute() {
    // Reset daily counters at midnight in IST timezone
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.dailyTradeCount = 0;
      this.lastResetDate = today;
      this.logger.info('Daily trade counter reset (IST)');

      // Also reset daily loss on portfolios
      await Portfolio.updateMany({}, { $set: { dailyLossToday: 0 } });
    }

    // Check all portfolios for risk breaches
    const portfolios = await Portfolio.find({});
    for (const portfolio of portfolios) {
      await this.checkPortfolioRisk(portfolio);
    }
  }

  /**
   * Validate a proposed trade signal against risk rules.
   * Returns { approved, reason } — the Execution Agent must call this before placing orders.
   */
  async validateTrade(signal, portfolio) {
    const checks = [];

    // 1. Emergency stop check
    if (this.emergencyActive) {
      return this.reject('Emergency stop is active — all trading halted', 'emergency_shutdown', signal);
    }

    // 2. Confidence threshold
    if (signal.confidence < RISK.MIN_CONFIDENCE_THRESHOLD) {
      return this.reject(
        `Confidence ${signal.confidence.toFixed(2)} below threshold ${RISK.MIN_CONFIDENCE_THRESHOLD}`,
        'low_confidence',
        signal
      );
    }

    // 2b. Anti-Whipsaw Cooldown check
    const COOLDOWN_DURATION_MS = 2 * 60 * 60 * 1000; // 2-hour cooldown
    if (portfolio) {
      const lastClosedTrade = await Trade.findOne({
        userId: portfolio.userId,
        asset: signal.asset,
        status: 'closed',
      }).sort({ closedAt: -1 });

      if (lastClosedTrade) {
        const timeSinceClose = Date.now() - new Date(lastClosedTrade.closedAt).getTime();
        const netReturn = lastClosedTrade.pnl - lastClosedTrade.fees;
        
        // If the last trade on this asset ended in a loss and happened within 2 hours
        if (netReturn < 0 && timeSinceClose < COOLDOWN_DURATION_MS) {
          const minutesRemaining = Math.ceil((COOLDOWN_DURATION_MS - timeSinceClose) / 60000);
          return this.reject(
            `Anti-Whipsaw Cooldown active for ${signal.asset}: stopped out in a loss recently. Paused for ${minutesRemaining} more minutes.`,
            'whipsaw_cooldown',
            signal
          );
        }
      }
    }

    // 2c. Multi-Timeframe Macro Trend check (1-Hour EMA 200)
    try {
      this.logger.info(`Fetching 1-Hour candles for ${signal.asset} macro trend verification...`);
      const hourCandles = await fetchCandles(signal.asset, '1h', 250);
      if (hourCandles && hourCandles.length >= 200) {
        const closes = hourCandles.map((c) => c.close);
        const ema200Values = EMA.calculate({ values: closes, period: 200 });
        const latestEma200 = ema200Values[ema200Values.length - 1];
        const latestPrice = closes[closes.length - 1];

        if (latestEma200 && latestPrice) {
          if (signal.action === ACTIONS.BUY && latestPrice < latestEma200) {
            return this.reject(
              `Macro Trend Blocked: ${signal.asset} price ($${latestPrice.toFixed(4)}) is below 1-Hour EMA 200 ($${latestEma200.toFixed(4)}). Bullish bias required.`,
              'macro_trend_blocked',
              signal
            );
          }
          if (signal.action === ACTIONS.SELL && latestPrice > latestEma200) {
            return this.reject(
              `Macro Trend Blocked: ${signal.asset} price ($${latestPrice.toFixed(4)}) is above 1-Hour EMA 200 ($${latestEma200.toFixed(4)}). Bearish bias required.`,
              'macro_trend_blocked',
              signal
            );
          }
          this.logger.info(`✅ Macro trend confirmed for ${signal.asset}: Price ($${latestPrice.toFixed(4)}) aligns with 1h EMA 200 ($${latestEma200.toFixed(4)})`);
        }
      } else {
        this.logger.warn(`Insufficient 1-Hour candles for ${signal.asset} macro trend verification (${hourCandles?.length || 0}/250) — allowing trade`);
      }
    } catch (err) {
      this.logger.error(`Error verifying macro trend confirmation for ${signal.asset}: ${err.message} — allowing trade as fallback`);
    }

    // 3. Max risk per trade
    const positionPct = parseFloat(signal.positionSize) / 100;
    if (positionPct > RISK.MAX_RISK_PER_TRADE * 10) { // position size check
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
          if (dailyLossPct >= RISK.MAX_DAILY_LOSS) {
            return this.reject(
              `Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds limit ${(RISK.MAX_DAILY_LOSS * 100).toFixed(1)}% of start-of-day capital ($${startingCapital.toFixed(2)})`,
              'daily_loss_limit',
              signal
            );
          }
        }
      }

      // 5.5. Duplicate position check
      const hasOpenPosition = portfolio.positions?.some((p) => p.asset === signal.asset && p.status === 'open');
      if (hasOpenPosition) {
        return this.reject(
          `Position already open for ${signal.asset}`,
          'duplicate_position',
          signal
        );
      }

      // 6. Max open positions checks
      const openPositionsList = portfolio.positions?.filter((p) => p.status === 'open') || [];
      const totalOpen = openPositionsList.length;

      if (totalOpen >= RISK.MAX_OPEN_POSITIONS) {
        return this.reject(
          `${totalOpen} open positions — max is ${RISK.MAX_OPEN_POSITIONS}`,
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

  incrementDailyTradeCount() {
    this.dailyTradeCount++;
    this.logger.info(`Incremented daily trade count: ${this.dailyTradeCount}/${this.maxDailyTrades}`);
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
        if (dailyLossPct >= RISK.MAX_DAILY_LOSS * 0.8) {
          await RiskEvent.create({
            type: 'daily_loss_limit',
            severity: dailyLossPct >= RISK.MAX_DAILY_LOSS ? 'critical' : 'warning',
            message: `Daily loss at ${(dailyLossPct * 100).toFixed(1)}% of start-of-day capital ($${startingCapital.toFixed(2)})`,
            currentValue: dailyLossPct,
            threshold: RISK.MAX_DAILY_LOSS,
          });
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
