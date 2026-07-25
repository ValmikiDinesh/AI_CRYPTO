import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { computeIndicators, generateTechnicalSignal } from '../../services/indicatorService.js';
import Signal from '../../models/Signal.js';

/**
 * Technical Analysis Agent
 * - Receives candle data from Market Agent.
 * - Computes RSI, MACD, EMA, BB, ATR, Stochastic.
 * - Detects market regime.
 * - Publishes technical signals.
 */
export default class TechnicalAgent extends BaseAgent {
  constructor(marketAgent) {
    super(AGENT_NAMES.TECHNICAL);
    this.marketAgent = marketAgent;
    this.lastSignals = {};       // asset → most recent signal
  }

  async execute() {
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const candles = this.marketAgent.getCandles(asset);

        if (!candles || candles.length < 30) {
          continue;
        }

        // Compute all indicators
        const indicators = computeIndicators(candles);

        if (indicators.error) {
          this.logger.warn(`${asset}: ${indicators.error}`);
          continue;
        }

        // Generate signal
        const signal = generateTechnicalSignal(indicators);

        const signalData = {
          asset,
          action: signal.action,
          confidence: signal.confidence,
          source: 'technical',
          reasoning: signal.reason,
          indicators: {
            rsi: indicators.rsi,
            macd: indicators.macd,
            ema: indicators.ema,
            bollingerBands: indicators.bollingerBands,
            atr: indicators.atr,
            volume: indicators.volume,
            momentum: indicators.momentum,
            regime: indicators.regime,
          },
          stopLoss: indicators.currentPrice * (1 - (indicators.atr / indicators.currentPrice) * 2),
          takeProfit: indicators.currentPrice * (1 + (indicators.atr / indicators.currentPrice) * 3),
        };

        this.lastSignals[asset] = signalData;

        // Persist to MongoDB
        await Signal.create(signalData);

        // Publish via Redis
        await publishEvent(CHANNELS.TECHNICAL_SIGNALS, signalData);

        this.logger.info(
          `${asset}: ${signal.action} (confidence=${signal.confidence.toFixed(2)}, regime=${indicators.regime})`
        );
      } catch (err) {
        this.logger.error(`${asset} analysis error: ${err.message}`);
      }
    }
  }

  getLastSignal(asset) {
    return this.lastSignals[asset] || null;
  }
}
