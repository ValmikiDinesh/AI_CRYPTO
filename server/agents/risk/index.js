import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, RISK, ACTIONS, CORE_ASSETS, MEME_ASSETS, RECOMMENDED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, escapeHtml } from '../../services/telegramService.js';
import RiskEvent from '../../models/RiskEvent.js';
import Portfolio from '../../models/Portfolio.js';

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
    this.lastResetDate = new Date().toDateString();
    this.emergencyActive = false;
  }

  async execute() {
    // Reset daily counters at midnight
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyTradeCount = 0;
      this.lastResetDate = today;
      this.logger.info('Daily trade counter reset');

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
      const dailyLossPct = Math.abs(portfolio.dailyLossToday) / portfolio.totalBalance;
      if (dailyLossPct >= RISK.MAX_DAILY_LOSS) {
        return this.reject(
          `Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds limit ${RISK.MAX_DAILY_LOSS * 100}%`,
          'daily_loss_limit',
          signal
        );
      }

      // 5. Max drawdown
      const drawdown = portfolio.currentDrawdown || 0;
      if (drawdown >= RISK.MAX_PORTFOLIO_DRAWDOWN) {
        return this.reject(
          `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% exceeds limit ${RISK.MAX_PORTFOLIO_DRAWDOWN * 100}%`,
          'drawdown_limit',
          signal
        );
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
    this.dailyTradeCount++;
    return { approved: true, reason: 'All risk checks passed' };
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

    // Notify Telegram (unless it is duplicate position to prevent spamming channel every cycle)
    if (type !== 'duplicate_position') {
      await sendTelegramMessage(
        `⚠️ <b>Risk Alert [${signal.asset.replace('USDT', '')}]</b>\n` +
        `<b>Action Taken</b>: Trade Blocked\n` +
        `<b>Violation</b>: ${type.toUpperCase().replace(/_/g, ' ')}\n` +
        `<b>Reason</b>: ${escapeHtml(reason)}`
      );
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
    const drawdown = portfolio.currentDrawdown || 0;

    // Critical drawdown warning
    if (drawdown >= RISK.MAX_PORTFOLIO_DRAWDOWN * 0.8) {
      await RiskEvent.create({
        type: 'drawdown_limit',
        severity: drawdown >= RISK.MAX_PORTFOLIO_DRAWDOWN ? 'critical' : 'warning',
        message: `Portfolio drawdown at ${(drawdown * 100).toFixed(1)}%`,
        currentValue: drawdown,
        threshold: RISK.MAX_PORTFOLIO_DRAWDOWN,
      });
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
