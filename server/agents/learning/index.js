import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import Trade from '../../models/Trade.js';
import Strategy from '../../models/Strategy.js';
import VolatilityHistory from '../../models/VolatilityHistory.js';
import { fetchCandles } from '../../services/exchangeService.js';
import { computeIndicators } from '../../services/indicatorService.js';

/**
 * Learning Agent
 * - Analyzes successful and failed trades.
 * - Adapts strategy signal weights over time.
 * - Tracks pattern performance.
 * - Future: reinforcement learning integration.
 */
export default class LearningAgent extends BaseAgent {
  constructor(fusionAgent) {
    super(AGENT_NAMES.LEARNING);
    this.fusionAgent = fusionAgent;
    this.lastDailyUpdateDate = null;
  }

  async execute() {
    try {
      // 1. Run Daily Weekday Volatility Tracker (once a day in IST)
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
      if (this.lastDailyUpdateDate !== todayStr) {
        await this.updateDailyVolatilityHistory();
        this.lastDailyUpdateDate = todayStr;
      }

      // Analyze last 50 closed trades
      const closedTrades = await Trade.find({ status: 'closed' })
        .sort({ closedAt: -1 })
        .limit(50);

      if (closedTrades.length < 10) {
        this.logger.debug('Insufficient closed trades for learning (need >= 10)');
        return;
      }

      const analysis = this.analyzeTrades(closedTrades);
      const weightAdjustments = this.suggestWeightAdjustments(analysis);

      // Apply adjusted weights to Fusion Agent
      if (weightAdjustments) {
        this.fusionAgent.updateWeights(weightAdjustments);
        this.logger.info(`Weights adjusted: ${JSON.stringify(weightAdjustments)}`);
      }

      // Persist strategy performance
      await this.updateStrategy(analysis);

    } catch (err) {
      this.logger.error(`Learning cycle error: ${err.message}`);
    }
  }

  /**
   * Fetch the latest daily candle from Binance for all supported assets 
   * and update the VolatilityHistory weekday averages database.
   */
  async updateDailyVolatilityHistory() {
    this.logger.info('📊 Starting daily Day-of-Week Volatility tracking cycle...');
    const dayOfWeek = new Date().getDay(); // 0 = Sunday, 6 = Saturday
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    for (const asset of SUPPORTED_ASSETS) {
      try {
        // Stagger requests to avoid concurrent rate limit spikes
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Fetch last 2 daily candles to get the most recent completed day's volatility data
        const candles = await fetchCandles(asset, '1d', 2);
        if (!candles || candles.length === 0) continue;

        const lastCandle = candles[candles.length - 1];
        
        // Also fetch 5m candles to calculate current ATR
        const raw5mCandles = await fetchCandles(asset, '5m', 50);
        let currentAtr = 0;
        if (raw5mCandles && raw5mCandles.length >= 30) {
          const indicators = computeIndicators(raw5mCandles);
          currentAtr = indicators && !indicators.error ? indicators.atr : 0;
        }

        const high = lastCandle.high || lastCandle.close || 0;
        const low = lastCandle.low || lastCandle.close || 0;
        const close = lastCandle.close || 0;
        
        const range = high - low;
        const rangePct = close > 0 ? (range / close) * 100 : 0;

        await VolatilityHistory.findOneAndUpdate(
          { asset, date: todayStart },
          {
            asset,
            date: todayStart,
            dayOfWeek,
            highPrice: high,
            lowPrice: low,
            closePrice: close,
            dailyRange: range,
            dailyRangePct: rangePct,
            avgATR: currentAtr,
            volume: lastCandle.volume || 0,
          },
          { upsert: true, new: true }
        );
      } catch (err) {
        this.logger.warn(`Failed to update daily volatility history for ${asset}: ${err.message}`);
      }
    }
    this.logger.info('📊 Daily Day-of-Week Volatility tracking completed successfully.');
  }


  analyzeTrades(trades) {
    const winners = trades.filter((t) => t.pnl > 0);
    const losers = trades.filter((t) => t.pnl < 0);

    const avgWin = winners.length > 0
      ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length
      : 0;
    const avgLoss = losers.length > 0
      ? Math.abs(losers.reduce((s, t) => s + t.pnl, 0) / losers.length)
      : 0;

    const winRate = winners.length / trades.length;
    const profitFactor = losers.length === 0
      ? (winners.length > 0 ? 99.0 : 0)
      : (avgWin * winners.length) / (avgLoss * losers.length);

    // Analyze by confidence buckets
    const highConfTrades = trades.filter((t) => t.confidence >= 0.75);
    const lowConfTrades = trades.filter((t) => t.confidence < 0.65);
    const highConfWinRate = highConfTrades.length > 0
      ? highConfTrades.filter((t) => t.pnl > 0).length / highConfTrades.length
      : 0;

    return {
      totalTrades: trades.length,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      highConfWinRate,
      highConfTradeCount: highConfTrades.length,
      lowConfTradeCount: lowConfTrades.length,
    };
  }

  suggestWeightAdjustments(analysis) {
    // Only adjust if we have meaningful data
    if (analysis.totalTrades < 10) return null;

    const currentWeights = { ...this.fusionAgent.weights };
    const adjustmentRate = 0.02; // small incremental changes

    // If win rate is high with current weights, boost technical
    if (analysis.winRate > 0.6) {
      currentWeights.technical = Math.min(0.5, currentWeights.technical + adjustmentRate);
    }

    // If profit factor is low, increase prediction weight
    if (analysis.profitFactor < 1.0) {
      currentWeights.prediction = Math.min(0.4, currentWeights.prediction + adjustmentRate);
      currentWeights.sentiment = Math.max(0.1, currentWeights.sentiment - adjustmentRate);
    }

    // If high-confidence trades have good win rate, that's working — keep weights
    if (analysis.highConfWinRate > 0.7) {
      return currentWeights; // validation that current weights are effective
    }

    // Normalize weights to sum to 1
    const total = Object.values(currentWeights).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(currentWeights)) {
      currentWeights[key] = currentWeights[key] / total;
    }

    return currentWeights;
  }

  async updateStrategy(analysis) {
    try {
      await Strategy.findOneAndUpdate(
        { name: 'default' },
        {
          $set: {
            'performance.totalTrades': analysis.totalTrades,
            'performance.winRate': analysis.winRate,
            'performance.avgPnl': analysis.avgWin - analysis.avgLoss,
          },
          $inc: { version: 1 },
          lastOptimizedAt: new Date(),
        },
        { upsert: true }
      );
    } catch (err) {
      this.logger.error(`Strategy update failed: ${err.message}`);
    }
  }
}
