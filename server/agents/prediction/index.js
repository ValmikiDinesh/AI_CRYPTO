import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import Prediction from '../../models/Prediction.js';
import { generateBatchPredictions } from '../../services/aiService.js';
import { computeIndicators } from '../../services/indicatorService.js';

/**
 * Prediction Agent
 * - Gathers indicators and sentiment across all assets.
 * - Queries Gemini/OpenAI API using the cost-efficient Batching Strategy.
 * - Falls back to a robust Adaptive Crossover & Regime Matrix local model when keys are absent/fail.
 */
export default class PredictionAgent extends BaseAgent {
  constructor(marketAgent, sentimentAgent, technicalAgent) {
    super(AGENT_NAMES.PREDICTION);
    this.marketAgent = marketAgent;
    this.sentimentAgent = sentimentAgent;
    this.technicalAgent = technicalAgent;
    this.predictions = {};        // asset → latest prediction
  }

  async execute() {
    const assetsData = [];
    const candleMap = {};

    // 1. Gather technical and sentiment indicators for all assets
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const candles = this.marketAgent.getCandles(asset);
        if (!candles || candles.length < 20) {
          continue;
        }
        candleMap[asset] = candles;

        // Retrieve pre-computed indicators from TechnicalAgent or compute them
        const lastTechnicalSignal = this.technicalAgent ? this.technicalAgent.getLastSignal(asset) : null;
        let indicators = lastTechnicalSignal?.indicators;
        if (!indicators && candles.length >= 30) {
          indicators = computeIndicators(candles);
        }

        const sentiment = this.sentimentAgent ? this.sentimentAgent.getSentiment(asset) : null;
        const currentPrice = this.marketAgent.getPrice(asset) || candles[candles.length - 1].close;

        assetsData.push({
          asset,
          currentPrice,
          indicators: indicators && !indicators.error ? indicators : null,
          sentiment
        });
      } catch (err) {
        this.logger.error(`Error gathering data for ${asset}: ${err.message}`);
      }
    }

    if (assetsData.length === 0) {
      this.logger.warn('No assets had sufficient data for prediction');
      return;
    }

    // 2. Run local mathematical model as primary for all assets
    const fallbackAssetsData = [];
    const localPredictions = {};

    for (const data of assetsData) {
      const { asset } = data;
      const candles = candleMap[asset];
      const localPred = this.predictLocalFallback(asset, candles, data.indicators);
      
      localPredictions[asset] = localPred;

      // If local model is forced to fall back to 'statistical_baseline' due to insufficient indicator data,
      // we queue it for LLM fallback.
      if (localPred.model === 'statistical_baseline') {
        fallbackAssetsData.push(data);
      }
    }

    // 3. Query external AI Services ONLY for assets needing fallback (insufficient indicator data)
    let aiPredictions = null;
    if (fallbackAssetsData.length > 0) {
      try {
        this.logger.info(`AI Service: Querying LLM fallback for ${fallbackAssetsData.length} assets with insufficient indicator data`);
        aiPredictions = await generateBatchPredictions(fallbackAssetsData);
      } catch (err) {
        this.logger.warn(`AI Service fallback call failed: ${err.message}`);
      }
    }

    // 4. Process results and override baseline predictions if AI prediction succeeded
    for (const data of assetsData) {
      const { asset, currentPrice } = data;
      let prediction = localPredictions[asset];

      if (aiPredictions && prediction.model === 'statistical_baseline') {
        const aiPred = aiPredictions.find(p => p.asset === asset);
        if (aiPred && ['up', 'down', 'neutral', 'hold'].includes(aiPred.direction.toLowerCase())) {
          const isGroq = !!process.env.GROQ_API_KEY;
          const isGemini = !isGroq && (!!process.env.GEMINI_API_KEY || !!process.env.GEMINI_API_KEYS);
          const defaultModel = isGroq ? 'ai_groq' : (isGemini ? 'ai_gemini' : 'ai_openai');
          const normalizedDirection = aiPred.direction.toLowerCase() === 'hold' ? 'neutral' : aiPred.direction.toLowerCase();
          
          prediction = {
            asset,
            model: aiPred.sourceModel || defaultModel,
            horizon: '1h',
            direction: normalizedDirection,
            probability: aiPred.probability || 0.5,
            predictedPrice: aiPred.takeProfit || currentPrice,
            currentPrice,
            priceChangePercent: normalizedDirection === 'up' ? (aiPred.probability || 0.5) * 5 : normalizedDirection === 'down' ? -(aiPred.probability || 0.5) * 5 : 0,
            features: {
              indicators: data.indicators,
              sentiment: data.sentiment ? { label: data.sentiment.label, score: data.sentiment.sentiment } : null
            },
            metadata: {
              takeProfit: aiPred.takeProfit,
              stopLoss: aiPred.stopLoss,
              limitEntryPrice: aiPred.limitEntryPrice,
              reasoning: aiPred.reasoning
            }
          };
        }
      }

      this.predictions[asset] = prediction;

      try {
        // Persist
        await Prediction.create(prediction);

        // Publish
        await publishEvent(CHANNELS.PREDICTIONS, prediction);

        const reasoningSnippet = prediction.metadata?.reasoning || 'No details';
        this.logger.info(
          `${asset} (${prediction.model}): predicted ${prediction.direction} (prob=${prediction.probability.toFixed(2)}) — ${reasoningSnippet.substring(0, 80)}`
        );
      } catch (err) {
        this.logger.error(`Error saving prediction for ${asset}: ${err.message}`);
      }
    }
  }

  /**
   * High-performing Adaptive local fallback model.
   * Uses EMA Crossovers, RSI Boundaries, Bollinger Band breakouts, and Volume Confirmation.
   */
  predictLocalFallback(asset, candles, indicators) {
    const currentPrice = candles[candles.length - 1].close;

    // If indicators are not pre-computed, compute them on the fly
    let ind = indicators;
    if (!ind || ind.error) {
      if (candles.length >= 30) {
        ind = computeIndicators(candles);
      }
    }

    if (!ind || ind.error) {
      return {
        asset,
        model: 'statistical_baseline',
        horizon: '1h',
        direction: 'neutral',
        probability: 0.5,
        predictedPrice: currentPrice,
        currentPrice,
        priceChangePercent: 0,
        features: {},
        metadata: { reasoning: 'Insufficient indicator data, defaulting to neutral.' }
      };
    }

    const regime = ind.regime || 'ranging';
    const rsi = ind.rsi;
    const volRatio = ind.volume?.ratio || 1.0;
    const ema9 = ind.ema?.ema9;
    const ema21 = ind.ema?.ema21;
    const ema50 = ind.ema?.ema50;
    const macdHist = ind.macd?.histogram || 0;

    let score = 0.5; // Starts neutral
    let reasoning = '';

    if (regime === 'trending_up') {
      score = 0.55;
      reasoning = 'Uptrend regime detected.';
      if (ema9 > ema21) {
        score += 0.08;
        reasoning += ' EMA9 > EMA21 crossover.';
      }
      if (currentPrice > ema50) {
        score += 0.05;
        reasoning += ' Price above EMA50.';
      }
      if (rsi > 50 && rsi < 70) {
        score += 0.05;
        reasoning += ' RSI in healthy bullish zone.';
      }
      if (volRatio > 1.3) {
        score += 0.05;
        reasoning += ' Bullish volume confirmation.';
      }
    } else if (regime === 'trending_down') {
      score = 0.45;
      reasoning = 'Downtrend regime detected.';
      if (ema9 < ema21) {
        score -= 0.08;
        reasoning += ' EMA9 < EMA21 cross.';
      }
      if (currentPrice < ema50) {
        score -= 0.05;
        reasoning += ' Price below EMA50.';
      }
      if (rsi < 50 && rsi > 30) {
        score -= 0.05;
        reasoning += ' RSI in healthy bearish zone.';
      }
      if (volRatio > 1.3) {
        score -= 0.05;
        reasoning += ' Bearish volume pressure.';
      }
    } else if (regime === 'ranging') {
      reasoning = 'Ranging regime (mean reversion):';
      if (rsi < 35) {
        const overshoot = 35 - rsi;
        score = 0.55 + Math.min(0.15, overshoot * 0.015);
        reasoning += ` Oversold RSI (${rsi.toFixed(1)}) triggers BUY rebound.`;
      } else if (rsi > 65) {
        const overshoot = rsi - 65;
        score = 0.45 - Math.min(0.15, overshoot * 0.015);
        reasoning += ` Overbought RSI (${rsi.toFixed(1)}) triggers SELL pullback.`;
      } else {
        score = 0.5;
        reasoning += ' RSI neutral.';
      }
    } else if (regime === 'volatile') {
      reasoning = 'Volatile regime (momentum):';
      const change1h = ind.momentum?.priceChange1h || 0;
      if (change1h > 1.5) {
        score = 0.60;
        reasoning += ` Strong 1h momentum (${change1h.toFixed(2)}%) breakout BUY.`;
      } else if (change1h < -1.5) {
        score = 0.40;
        reasoning += ` Strong 1h momentum (${change1h.toFixed(2)}%) breakout SELL.`;
      } else {
        score = 0.5;
        reasoning += ' No clear momentum breakout.';
      }
    }

    let direction = 'neutral';
    let probability = 0.5;

    if (score > 0.55) {
      direction = 'up';
      probability = Math.min(0.95, score);
    } else if (score < 0.45) {
      direction = 'down';
      probability = Math.min(0.95, 1 - score);
    } else {
      direction = 'neutral';
      probability = 0.5;
    }

    // Calculate mathematical fallback targets based on current regime
    const atr = ind.atr || (currentPrice * 0.02);
    const bb = ind.bollingerBands || {};
    
    let fallbackLimitEntryPrice = currentPrice;
    let fallbackStopLoss = currentPrice;
    let fallbackTakeProfit = currentPrice;

    if (direction === 'up') {
      if (regime === 'trending_up') {
        const pullbackPrice = ema9 || (currentPrice - 0.25 * atr);
        fallbackLimitEntryPrice = Math.min(currentPrice, pullbackPrice);
        fallbackLimitEntryPrice = Math.max(fallbackLimitEntryPrice, currentPrice - 0.5 * atr);
      } else {
        const supportPrice = bb.lower || (currentPrice - 0.5 * atr);
        fallbackLimitEntryPrice = Math.min(currentPrice * 0.995, supportPrice);
      }
      fallbackLimitEntryPrice = Math.min(fallbackLimitEntryPrice, currentPrice - 0.05 * atr);
      fallbackLimitEntryPrice = Math.max(0.00000001, fallbackLimitEntryPrice);

      fallbackStopLoss = fallbackLimitEntryPrice - 1.5 * atr;
      fallbackTakeProfit = fallbackLimitEntryPrice + 3.0 * atr;
    } else if (direction === 'down') {
      if (regime === 'trending_down') {
        const rallyPrice = ema9 || (currentPrice + 0.25 * atr);
        fallbackLimitEntryPrice = Math.max(currentPrice, rallyPrice);
        fallbackLimitEntryPrice = Math.min(fallbackLimitEntryPrice, currentPrice + 0.5 * atr);
      } else {
        const resistancePrice = bb.upper || (currentPrice + 0.5 * atr);
        fallbackLimitEntryPrice = Math.max(currentPrice * 1.005, resistancePrice);
      }
      fallbackLimitEntryPrice = Math.max(fallbackLimitEntryPrice, currentPrice + 0.05 * atr);

      fallbackStopLoss = fallbackLimitEntryPrice + 1.5 * atr;
      fallbackTakeProfit = fallbackLimitEntryPrice - 3.0 * atr;
    }

    return {
      asset,
      model: 'adaptive_statistical_fallback',
      horizon: '1h',
      direction,
      probability,
      predictedPrice: currentPrice * (1 + (score - 0.5) * 0.1),
      currentPrice,
      priceChangePercent: (score - 0.5) * 10,
      features: {
        regime,
        rsi,
        volRatio,
        macdHist,
        ema9_21_cross: ema9 && ema21 ? (ema9 - ema21) / ema21 : 0
      },
      metadata: {
        reasoning,
        limitEntryPrice: fallbackLimitEntryPrice < 0.001 
          ? Math.round(fallbackLimitEntryPrice * 100000000) / 100000000 
          : fallbackLimitEntryPrice < 10 
            ? Math.round(fallbackLimitEntryPrice * 1000000) / 1000000 
            : Math.round(fallbackLimitEntryPrice * 100) / 100,
        stopLoss: fallbackLimitEntryPrice < 0.001 
          ? Math.round(fallbackStopLoss * 100000000) / 100000000 
          : fallbackLimitEntryPrice < 10 
            ? Math.round(fallbackStopLoss * 1000000) / 1000000 
            : Math.round(fallbackStopLoss * 100) / 100,
        takeProfit: fallbackLimitEntryPrice < 0.001 
          ? Math.round(fallbackTakeProfit * 100000000) / 100000000 
          : fallbackLimitEntryPrice < 10 
            ? Math.round(fallbackTakeProfit * 1000000) / 1000000 
            : Math.round(fallbackTakeProfit * 100) / 100,
      }
    };
  }

  getPrediction(asset) {
    return this.predictions[asset] || null;
  }
}

