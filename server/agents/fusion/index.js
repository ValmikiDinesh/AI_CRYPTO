import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS, ACTIONS, RISK } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import Signal from '../../models/Signal.js';

/**
 * Signal Fusion Agent
 * - Combines signals from Technical, Sentiment, and Prediction agents.
 * - Uses weighted ensemble scoring.
 * - Rejects low-confidence trades.
 * - Outputs BUY/SELL/HOLD recommendations.
 */
export default class FusionAgent extends BaseAgent {
  constructor(technicalAgent, sentimentAgent, predictionAgent, marketAgent) {
    super(AGENT_NAMES.FUSION);
    this.technicalAgent = technicalAgent;
    this.sentimentAgent = sentimentAgent;
    this.predictionAgent = predictionAgent;
    this.marketAgent = marketAgent;
    this.lastSignals = {};

    // Default weights (will be updated by Learning Agent)
    this.weights = {
      technical: 0.40,
      sentiment: 0.20,
      prediction: 0.30,
      momentum: 0.10,
    };
  }

  async execute() {
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const technical = this.technicalAgent.getLastSignal(asset);
        const sentiment = this.sentimentAgent.getSentiment(asset);
        const prediction = this.predictionAgent.getPrediction(asset);
        const currentPrice = this.marketAgent.getPrice(asset);

        if (!technical || !currentPrice) {
          this.logger.debug(`${asset}: insufficient data for fusion`);
          continue;
        }

        const fusedSignal = this.fuseSignals(asset, currentPrice, technical, sentiment, prediction);
        fusedSignal.timestamp = Date.now();

        // Persist all fused signals (including HOLD) to maintain a complete history for all assets
        const createdSignal = await Signal.create(fusedSignal);
        this.lastSignals[asset] = createdSignal;

        await publishEvent(CHANNELS.FUSED_SIGNALS, fusedSignal);

        this.logger.info(
          `${asset}: FUSED → ${fusedSignal.action} (confidence=${fusedSignal.confidence.toFixed(2)})`
        );
      } catch (err) {
        this.logger.error(`Fusion error for ${asset}: ${err.message}`);
      }
    }
  }

  fuseSignals(asset, currentPrice, technical, sentiment, prediction) {
    // Convert each agent's output to a directional score (-1 to +1)
    const techScore = this.actionToScore(technical.action) * (technical.confidence || 0.5);
    const sentScore = sentiment ? sentiment.sentiment * (sentiment.confidence || 0.5) : 0;
    const predScore = prediction
      ? (prediction.direction === 'up' ? 1 : prediction.direction === 'down' ? -1 : 0) * prediction.probability
      : 0;

    // Momentum from technical indicators
    const momentumScore = technical.indicators?.momentum?.priceChange1h
      ? Math.max(-1, Math.min(1, technical.indicators.momentum.priceChange1h / 5))
      : 0;

    // Weighted fusion
    const composite =
      techScore * this.weights.technical +
      sentScore * this.weights.sentiment +
      predScore * this.weights.prediction +
      momentumScore * this.weights.momentum;

    // Compute confidence (average of individual confidences, weighted)
    const confidence = Math.abs(composite);

    // Determine action
    let action = ACTIONS.HOLD;
    if (composite > 0.15 && confidence >= RISK.MIN_CONFIDENCE_THRESHOLD) {
      action = ACTIONS.BUY;
    } else if (composite < -0.15 && confidence >= RISK.MIN_CONFIDENCE_THRESHOLD) {
      action = ACTIONS.SELL;
    }
    let limitEntryPrice = currentPrice;
    let stopLoss = currentPrice;
    let takeProfit = currentPrice;
    const trailingPct = parseFloat(process.env.TRAILING_STOP_PCT) || 0.03; // Default 3.0% trailing stop
    let usedAiTargets = false;

    if (action !== ACTIONS.HOLD) {
      const regime = technical.indicators?.regime || 'ranging';
      const atr = technical.indicators?.atr || (currentPrice * 0.02); // Fallback to 2% volatility
      const ema9 = technical.indicators?.ema?.ema9;
      const bb = technical.indicators?.bollingerBands || {};

      const predDir = prediction?.direction;
      const predMetadata = prediction?.metadata || {};

      if (action === ACTIONS.BUY) {
        // Validate and use AI-defined levels if direction-aligned and structurally correct
        if (predDir === 'up' && predMetadata.limitEntryPrice && predMetadata.stopLoss && predMetadata.takeProfit) {
          const aiEntry = parseFloat(predMetadata.limitEntryPrice);
          const aiSL = parseFloat(predMetadata.stopLoss);
          const aiTP = parseFloat(predMetadata.takeProfit);
          
          if (aiEntry < currentPrice && aiSL < aiEntry && aiTP > aiEntry) {
            limitEntryPrice = aiEntry;
            stopLoss = aiSL;
            takeProfit = aiTP;
            usedAiTargets = true;
          }
        }

        if (!usedAiTargets) {
          // Fallback to regime-adaptive technical indicator targets
          if (regime === 'trending_up') {
            const pullbackPrice = ema9 || (currentPrice - 0.25 * atr);
            limitEntryPrice = Math.min(currentPrice, pullbackPrice);
            limitEntryPrice = Math.max(limitEntryPrice, currentPrice - 0.5 * atr);
          } else {
            const supportPrice = bb.lower || (currentPrice - 0.5 * atr);
            limitEntryPrice = Math.min(currentPrice * 0.995, supportPrice);
          }
          limitEntryPrice = Math.min(limitEntryPrice, currentPrice - 0.05 * atr);
          limitEntryPrice = Math.max(0.00000001, limitEntryPrice);

          stopLoss = limitEntryPrice - 1.5 * atr;
          takeProfit = limitEntryPrice + 3.0 * atr;
        }
      } else if (action === ACTIONS.SELL) {
        // Validate and use AI-defined levels if direction-aligned and structurally correct
        if (predDir === 'down' && predMetadata.limitEntryPrice && predMetadata.stopLoss && predMetadata.takeProfit) {
          const aiEntry = parseFloat(predMetadata.limitEntryPrice);
          const aiSL = parseFloat(predMetadata.stopLoss);
          const aiTP = parseFloat(predMetadata.takeProfit);

          if (aiEntry > currentPrice && aiSL > aiEntry && aiTP < aiEntry) {
            limitEntryPrice = aiEntry;
            stopLoss = aiSL;
            takeProfit = aiTP;
            usedAiTargets = true;
          }
        }

        if (!usedAiTargets) {
          // Fallback to regime-adaptive technical indicator targets
          if (regime === 'trending_down') {
            const rallyPrice = ema9 || (currentPrice + 0.25 * atr);
            limitEntryPrice = Math.max(currentPrice, rallyPrice);
            limitEntryPrice = Math.min(limitEntryPrice, currentPrice + 0.5 * atr);
          } else {
            const resistancePrice = bb.upper || (currentPrice + 0.5 * atr);
            limitEntryPrice = Math.max(currentPrice * 1.005, resistancePrice);
          }
          limitEntryPrice = Math.max(limitEntryPrice, currentPrice + 0.05 * atr);

          stopLoss = limitEntryPrice + 1.5 * atr;
          takeProfit = limitEntryPrice - 3.0 * atr;
        }
      }
    }

    // Dynamic position sizing based on Fractional Kelly Criterion (Quarter-Kelly)
    let positionPercent = 1.0; // Default 1%
    if (action !== ACTIONS.HOLD) {
      const p = confidence;
      const riskDistance = Math.abs(limitEntryPrice - stopLoss);
      const rewardDistance = Math.abs(takeProfit - limitEntryPrice);
      const b = riskDistance > 0 ? (rewardDistance / riskDistance) : 2.0;

      // Kelly Formula: f* = (p * b - q) / b
      const kellyFraction = b > 0 ? ((p * b - (1 - p)) / b) : 0;
      const targetPercent = 0.50 * kellyFraction * 100; // Half-Kelly in % (aggressive sizing)
      
      // Cap the trade allocation between 0.5% and 15% of portfolio capital (aggressive risk management)
      positionPercent = Math.min(15, Math.max(0.5, targetPercent));
    }

    // Compute risk score (lower = safer)
    const riskScore = this.computeRiskScore(confidence, technical, sentiment);

    return {
      asset,
      action,
      confidence,
      riskScore,
      source: 'fusion',
      positionSize: `${positionPercent.toFixed(1)}%`,
      trailingPct,
      limitEntryPrice: limitEntryPrice < 0.001 
        ? Math.round(limitEntryPrice * 100000000) / 100000000 
        : limitEntryPrice < 10 
          ? Math.round(limitEntryPrice * 1000000) / 1000000 
          : Math.round(limitEntryPrice * 100) / 100,
      stopLoss: limitEntryPrice < 0.001 
        ? Math.round(stopLoss * 100000000) / 100000000 
        : limitEntryPrice < 10 
          ? Math.round(stopLoss * 1000000) / 1000000 
          : Math.round(stopLoss * 100) / 100,
      takeProfit: limitEntryPrice < 0.001 
        ? Math.round(takeProfit * 100000000) / 100000000 
        : limitEntryPrice < 10 
          ? Math.round(takeProfit * 1000000) / 1000000 
          : Math.round(takeProfit * 100) / 100,
      reasoning: this.buildReasoning(action, technical, sentiment, prediction, composite),
      weights: { ...this.weights },
      indicators: {
        techScore,
        sentScore,
        predScore,
        momentumScore,
        composite,
      },
      metadata: {
        sourceModel: prediction?.model || 'none',
        usedAiTargets
      }
    };
  }

  actionToScore(action) {
    if (action === ACTIONS.BUY) return 1;
    if (action === ACTIONS.SELL) return -1;
    return 0;
  }

  computeRiskScore(confidence, technical, sentiment) {
    let risk = 0.5;

    // Low confidence → higher risk
    risk += (1 - confidence) * 0.2;

    // High volatility → higher risk
    if (technical.indicators?.regime === 'volatile') risk += 0.15;

    // Negative sentiment adds risk
    if (sentiment && sentiment.sentiment < -0.3) risk += 0.1;

    return Math.max(0, Math.min(1, risk));
  }

  buildReasoning(action, technical, sentiment, prediction, composite) {
    const parts = [];
    if (technical) parts.push(`Technical: ${technical.action} (${technical.indicators?.regime || 'unknown'} regime)`);
    if (sentiment) parts.push(`Sentiment: ${sentiment.label} (score=${sentiment.sentiment?.toFixed(2)})`);
    if (prediction) parts.push(`Prediction: ${prediction.direction} (prob=${prediction.probability?.toFixed(2)})`);
    parts.push(`Composite score: ${composite.toFixed(3)}`);
    return `${action} decision — ${parts.join('; ')}`;
  }

  getLastSignal(asset) {
    return this.lastSignals[asset] || null;
  }

  updateWeights(newWeights) {
    this.weights = { ...this.weights, ...newWeights };
    this.logger.info(`Weights updated: ${JSON.stringify(this.weights)}`);
  }
}
