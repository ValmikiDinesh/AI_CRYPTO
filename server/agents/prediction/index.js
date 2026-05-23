import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import Prediction from '../../models/Prediction.js';

/**
 * Prediction Agent
 * - Uses simple statistical models as a baseline.
 * - Outputs directional probability predictions.
 * - Designed to be upgraded with TensorFlow.js LSTM/Transformer models.
 */
export default class PredictionAgent extends BaseAgent {
  constructor(marketAgent) {
    super(AGENT_NAMES.PREDICTION);
    this.marketAgent = marketAgent;
    this.predictions = {};        // asset → latest prediction
  }

  async execute() {
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const candles = this.marketAgent.getCandles(asset);

        if (!candles || candles.length < 20) {
          continue;
        }

        const prediction = this.predict(asset, candles);

        this.predictions[asset] = prediction;

        // Persist
        await Prediction.create(prediction);

        // Publish
        await publishEvent(CHANNELS.PREDICTIONS, prediction);

        this.logger.info(
          `${asset}: predicted ${prediction.direction} (prob=${prediction.probability.toFixed(2)})`
        );
      } catch (err) {
        this.logger.error(`Prediction error for ${asset}: ${err.message}`);
      }
    }
  }

  /**
   * Baseline statistical prediction using momentum, mean-reversion, and volatility.
   * This is a placeholder — replace with TensorFlow.js LSTM in Phase 4.
   */
  predict(asset, candles) {
    const closes = candles.map((c) => c.close);
    const current = closes[closes.length - 1];

    // Short-term momentum (5-period)
    const shortMomentum = (current - closes[closes.length - 6]) / closes[closes.length - 6];

    // Medium-term momentum (20-period)
    const medMomentum = closes.length >= 21
      ? (current - closes[closes.length - 21]) / closes[closes.length - 21]
      : 0;

    // Volatility (std dev of 20-period returns)
    const returns = [];
    for (let i = Math.max(1, closes.length - 20); i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);

    // Mean reversion signal
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const deviation = (current - sma20) / sma20;

    // Composite score
    let score = 0;
    score += shortMomentum * 0.3;           // momentum
    score += medMomentum * 0.2;             // trend
    score -= deviation * 0.3;               // mean reversion
    score -= volatility * 0.2;              // high vol → bearish bias

    // Convert to probability
    const probability = 1 / (1 + Math.exp(-score * 50)); // sigmoid

    let direction = 'neutral';
    if (probability > 0.55) direction = 'up';
    else if (probability < 0.45) direction = 'down';

    return {
      asset,
      model: 'statistical_baseline',
      horizon: '1h',
      direction,
      probability: direction === 'down' ? 1 - probability : probability,
      predictedPrice: current * (1 + score),
      currentPrice: current,
      priceChangePercent: score * 100,
      features: {
        shortMomentum,
        medMomentum,
        volatility,
        deviation,
        sma20,
      },
    };
  }

  getPrediction(asset) {
    return this.predictions[asset] || null;
  }
}
