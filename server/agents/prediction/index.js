import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, subscribeToChannel, CHANNELS } from '../../config/redis.js';
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
    this.portfolioConfig = {};
  }

  async initialize() {
    await super.initialize();
    await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, (config) => {
      this.portfolioConfig = config;
    });
    
    // Load initial config
    try {
      const Portfolio = (await import('../../models/Portfolio.js')).default;
      const port = await Portfolio.findOne({ userId: 'system' }).lean();
      if (port) this.portfolioConfig = port;
    } catch (e) {
      this.logger.warn(`Failed to load initial portfolio config in PredictionAgent`);
    }
  }

  async execute() {
    if (!this._calcCache) this._calcCache = {};
    const assetsData = [];
    const candleMap = {};

    let count = 0;
    // 1. Gather technical and sentiment indicators for all assets
    for (const asset of SUPPORTED_ASSETS) {
      count++;
      if (count % 40 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      try {
        const candles = this.marketAgent.getCandles(asset);
        if (!candles || candles.length < 20) {
          continue;
        }

        const lastCandle = candles[candles.length - 1];
        const cacheKey = `${lastCandle.close}_${lastCandle.closeTime ? new Date(lastCandle.closeTime).getTime() : 0}`;

        // Smart Cache Guard: Skip if price and candle timeframe have not changed
        if (this._calcCache[asset] === cacheKey && this.predictions[asset]) {
          continue;
        }

        this._calcCache[asset] = cacheKey;
        candleMap[asset] = candles;

        // Retrieve pre-computed indicators from TechnicalAgent or compute them
        const lastTechnicalSignal = this.technicalAgent ? this.technicalAgent.getLastSignal(asset) : null;
        let indicators = lastTechnicalSignal?.indicators;
        if (!indicators && candles.length >= 30) {
          indicators = computeIndicators(candles);
        }

        const sentiment = this.sentimentAgent ? this.sentimentAgent.getSentiment(asset) : null;
        const currentPrice = this.marketAgent.getPrice(asset) || lastCandle.close;

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
      return;
    }

    // 2. Query primary external AI Services via Batching Strategy (If Enabled)
    let aiPredictions = null;
    if (this.portfolioConfig && this.portfolioConfig.enableAILlmPredictions) {
      try {
        this.logger.info(`AI Gateway: Enabled. Routing ${assetsData.length} assets to AI Service using configured sequence.`);
        aiPredictions = await generateBatchPredictions(assetsData, this.portfolioConfig);
      } catch (err) {
        this.logger.error(`AI Gateway Error: ${err.message}. Falling back to Local Math Model.`);
      }
    } else {
      this.logger.debug(`AI Gateway: Disabled. Routing 100% of assets to Local Math Model (Primary Default).`);
    }

    // 3. Process results and apply Local Mathematical Model as Primary Default / AI Fallback
    for (const data of assetsData) {
      const { asset, currentPrice } = data;
      const candles = candleMap[asset];
      
      let prediction = null;

      // 🛡️ FIX: If AI is enabled and successfully returned a prediction, use it!
      if (aiPredictions) {
        const aiPred = aiPredictions.find(p => p.asset === asset);
        if (aiPred && ['up', 'down', 'neutral', 'hold'].includes(aiPred.direction.toLowerCase())) {
          const normalizedDirection = aiPred.direction.toLowerCase() === 'hold' ? 'neutral' : aiPred.direction.toLowerCase();
          
          prediction = {
            asset,
            model: aiPred.sourceModel || 'ai_llm',
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
              reasoning: aiPred.reasoning,
              activeStrategy: this.portfolioConfig?.activeStrategy || 'trend_sniper'
            }
          };
        }
      }

      // 🛡️ FIX: If AI is disabled OR AI failed to predict this asset, instantly use the fast robust Local Mathematical Fallback
      if (!prediction) {
        prediction = await this.predictLocalFallback(asset, candles, data.indicators);
      }

      this.predictions[asset] = prediction;

      // Publish directional predictions via Redis in-memory stream
      if (prediction.direction !== 'neutral' && prediction.probability >= 0.55) {
        try {
          await publishEvent(CHANNELS.PREDICTIONS, prediction);

          const reasoningSnippet = prediction.metadata?.reasoning || 'No details';
          this.logger.info(
            `⚡ [PREDICTION] ${asset} (${prediction.model}): predicted ${prediction.direction} (prob=${prediction.probability.toFixed(2)}) — ${reasoningSnippet.substring(0, 80)}`
          );
        } catch (err) {
          const errStr = (err.message || '').toLowerCase();
          if (!errStr.includes('client must be connected') && !errStr.includes('client was closed')) {
            this.logger.error(`Error saving prediction for ${asset}: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * High-performing Adaptive local fallback model.
   * Uses EMA Crossovers, RSI Boundaries, Bollinger Band breakouts, and Volume Confirmation.
   */
  async predictLocalFallback(asset, candles, indicators) {
    const currentPrice = candles[candles.length - 1].close;

    // Phase 4: Multi-Timeframe (MTF) Macro Fetch for Sniper Strategy
    let macroRegime = null;
    const activeStrategy = this.portfolioConfig?.activeStrategy || 'trend_sniper';
    if (activeStrategy === 'trend_sniper') {
      try {
        const { fetchCandles } = await import('../../services/exchangeService.js');
        const macroCandles = await fetchCandles(asset, '1d', 50);
        if (macroCandles && macroCandles.length >= 30) {
          const { computeIndicators } = await import('../../services/indicatorService.js');
          const macroInd = computeIndicators(macroCandles);
          macroRegime = macroInd.regime;
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch MTF macro data for ${asset}: ${err.message}`);
      }
    }

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
    const atr = ind.atr || (currentPrice * 0.02);
    const bb = ind.bollingerBands || {};

    let score = 0.5; // Starts neutral
    let reasoning = '';

    // Dynamic Multi-Strategy Engine
    const settings = this.portfolioConfig?.strategySettings?.[activeStrategy] || {};
    
    // Dynamic Fee Fetcher (Taker + Taker assumed for safety if market, Maker if limit)
    const { getExchange } = await import('../../services/exchangeService.js');
    const exchange = getExchange();
    const fees = await exchange.fetchAssetFeeRate(asset);
    
    const entryType = this.portfolioConfig?.entryOrderType === 'limit' ? fees.maker : fees.taker;
    const exitType = this.portfolioConfig?.exitOrderType === 'limit' ? fees.maker : fees.taker;
    const roundTripFeePct = (entryType + exitType) * 100; // e.g. (0.0002 + 0.0005) * 100 = 0.07%

    const atrPct = (atr / currentPrice) * 100;

    if (activeStrategy === 'hft_scalping') {
      // SCALPER: Enforce Fee-Bleed Filter
      if (atrPct < roundTripFeePct * 1.5) { // Needs 1.5x the fee to be worth it
        return {
          asset, model: 'hft_scalping', horizon: '1h', direction: 'neutral', probability: 0.5,
          predictedPrice: currentPrice, currentPrice, priceChangePercent: 0, features: {},
          metadata: { reasoning: `Fee-Bleed Protection: ATR (${atrPct.toFixed(3)}%) too low for fees (${roundTripFeePct.toFixed(3)}%).` }
        };
      }
    }

    if (regime === 'trending_up') {
      score = 0.55;
      reasoning = 'Uptrend regime detected.';
      if (ema9 > ema21) { score += 0.08; reasoning += ' EMA9 > EMA21 cross.'; }
      if (currentPrice > ema50) { score += 0.05; reasoning += ' Price above EMA50.'; }
      if (rsi > 50 && rsi < 70) { score += 0.05; reasoning += ' RSI bullish zone.'; }
      if (volRatio > 1.3) { score += 0.05; reasoning += ' Bullish volume.'; }
      
      if (activeStrategy === 'trend_sniper') {
        // Phase 4: MTF Macro Filter
        if (macroRegime === 'trending_down') {
          score = 0.5;
          reasoning = `SNIPER REJECT (MTF): Refusing to buy against Bearish Macro Trend (1D).`;
        }
        // SNIPER: Strict MACD Alignment Filter
        else if (macdHist <= 0) {
          score = 0.5;
          reasoning += ' SNIPER REJECT: MACD Histogram not aligned.';
        }
      }
    } else if (regime === 'trending_down') {
      score = 0.45;
      reasoning = 'Downtrend regime detected.';
      if (ema9 < ema21) { score -= 0.08; reasoning += ' EMA9 < EMA21 cross.'; }
      if (currentPrice < ema50) { score -= 0.05; reasoning += ' Price below EMA50.'; }
      if (rsi < 50 && rsi > 30) { score -= 0.05; reasoning += ' RSI bearish zone.'; }
      if (volRatio > 1.3) { score -= 0.05; reasoning += ' Bearish volume.'; }
      
      if (activeStrategy === 'trend_sniper') {
        // Phase 4: MTF Macro Filter
        if (macroRegime === 'trending_up') {
          score = 0.5;
          reasoning = `SNIPER REJECT (MTF): Refusing to short against Bullish Macro Trend (1D).`;
        }
        // SNIPER: Strict MACD Alignment Filter
        else if (macdHist >= 0) {
          score = 0.5;
          reasoning += ' SNIPER REJECT: MACD Histogram not aligned.';
        }
      }
    } else if (regime === 'ranging') {
      if (activeStrategy === 'trend_sniper') {
        // SNIPER: Ranging Filter
        score = 0.5;
        reasoning = 'SNIPER REJECT: Market is ranging. Waiting for breakout.';
      } else {
        // SCALPER: Aggressive Mean Reversion
        reasoning = 'SCALPER: Ranging mean-reversion.';
        if (rsi < 35 && currentPrice < (bb.lower || currentPrice)) {
          score = 0.75;
          reasoning += ` Oversold bounce off BB lower (${rsi.toFixed(1)}).`;
        } else if (rsi > 65 && currentPrice > (bb.upper || currentPrice)) {
          score = 0.25;
          reasoning += ` Overbought rejection off BB upper (${rsi.toFixed(1)}).`;
        } else {
          score = 0.5;
          reasoning += ' RSI neutral in range.';
        }
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

    // Autonomous Asset-Specific ATR Scaling Engine
    let slMult = activeStrategy === 'trend_sniper' ? 2.0 : 1.2;
    let tpMult = activeStrategy === 'trend_sniper' ? 3.0 : 1.5;
    let autonomousAlert = null;

    if (activeStrategy === 'trend_sniper') {
      if (volRatio > 1.5) {
        slMult = 3.5;
        tpMult = 4.0;
        autonomousAlert = `Extreme Volatility Spike Detected (VolRatio: ${volRatio.toFixed(2)}x).\nAction: Autonomously widened Stop-Loss to 3.5x ATR to survive turbulence and prevent early liquidation.`;
      } else if (volRatio < 0.8) {
        slMult = 1.5;
        tpMult = 2.0;
      }
    } else if (activeStrategy === 'hft_scalping') {
      if (regime === 'volatile' || volRatio > 1.8) {
        slMult = 0.8;
        tpMult = 1.2;
        autonomousAlert = `Flash Volatility Spike Detected (VolRatio: ${volRatio.toFixed(2)}x).\nAction: Autonomously tightened Stop-Loss to 0.8x ATR to abort quickly and prevent heavy drawdown.`;
      } else if (regime === 'ranging') {
        slMult = 1.2;
        tpMult = 1.5;
      }
    }

    // The alert will be passed via metadata to EMS, which fires it ONLY if the trade actually executes

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

      fallbackStopLoss = Math.max(0.00000001, fallbackLimitEntryPrice - slMult * atr);
      fallbackTakeProfit = fallbackLimitEntryPrice + tpMult * atr;
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

      fallbackStopLoss = fallbackLimitEntryPrice + slMult * atr;
      fallbackTakeProfit = Math.max(0.00000001, fallbackLimitEntryPrice - tpMult * atr);
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
        trailingAtrMult: slMult,
        entryAtr: atr,
        activeStrategy: activeStrategy,
        autonomousAlert: autonomousAlert
      }
    };
  }

  getPrediction(asset) {
    return this.predictions[asset] || null;
  }
}

