import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES } from '../../config/constants.js';
import Trade from '../../models/Trade.js';
import Strategy from '../../models/Strategy.js';

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
  }

  async execute() {
    try {
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
    const profitFactor = avgLoss > 0 ? (avgWin * winners.length) / (avgLoss * losers.length) : 0;

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
