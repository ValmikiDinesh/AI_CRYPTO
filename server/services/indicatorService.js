import { RSI, MACD, EMA, BollingerBands, ATR, SMA, Stochastic } from 'technicalindicators';

/**
 * Compute all technical indicators from OHLCV candle data.
 * @param {Array} candles – array of { open, high, low, close, volume }
 * @returns {Object} computed indicators + regime + confidence
 */
export const computeIndicators = (candles) => {
  if (!candles || candles.length < 30) {
    return { error: 'Insufficient data — need at least 30 candles' };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // ── RSI (14) ──────────────────────────────────────────
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues[rsiValues.length - 1];

  // ── MACD (12, 26, 9) ─────────────────────────────────
  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macd = macdResult[macdResult.length - 1] || {};

  // ── EMA (9, 21, 50) ──────────────────────────────────
  const ema9 = EMA.calculate({ values: closes, period: 9 });
  const ema21 = EMA.calculate({ values: closes, period: 21 });
  const ema50 = EMA.calculate({ values: closes, period: Math.min(50, closes.length - 1) });

  // ── Bollinger Bands (20, 2) ───────────────────────────
  const bbResult = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bb = bbResult[bbResult.length - 1] || {};

  // ── ATR (14) — volatility ────────────────────────────
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues[atrValues.length - 1];

  // ── SMA (20, 50) ─────────────────────────────────────
  const sma20 = SMA.calculate({ values: closes, period: 20 });
  const sma50 = SMA.calculate({ values: closes, period: Math.min(50, closes.length - 1) });

  // ── Stochastic (14, 3, 3) ────────────────────────────
  const stochResult = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
    signalPeriod: 3,
  });
  const stochastic = stochResult[stochResult.length - 1] || {};

  // ── Volume analysis ──────────────────────────────────
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;

  // ── Price momentum ───────────────────────────────────
  const priceChange1h = closes.length >= 12
    ? ((closes[closes.length - 1] - closes[closes.length - 12]) / closes[closes.length - 12]) * 100
    : 0;
  const priceChange4h = closes.length >= 48
    ? ((closes[closes.length - 1] - closes[closes.length - 48]) / closes[closes.length - 48]) * 100
    : 0;

  // ── Market regime detection ──────────────────────────
  const regime = detectRegime({ rsi, macd, ema9, ema21, bb, closes });

  // ── Confidence score ─────────────────────────────────
  const confidence = computeConfidence({ rsi, macd, regime, volumeRatio, stochastic });

  return {
    currentPrice: closes[closes.length - 1],
    rsi,
    macd: {
      value: macd.MACD,
      signal: macd.signal,
      histogram: macd.histogram,
    },
    ema: {
      ema9: ema9[ema9.length - 1],
      ema21: ema21[ema21.length - 1],
      ema50: ema50[ema50.length - 1],
    },
    bollingerBands: {
      upper: bb.upper,
      middle: bb.middle,
      lower: bb.lower,
    },
    atr,
    sma: {
      sma20: sma20[sma20.length - 1],
      sma50: sma50[sma50.length - 1],
    },
    stochastic: {
      k: stochastic.k,
      d: stochastic.d,
    },
    volume: {
      current: currentVolume,
      average: avgVolume,
      ratio: volumeRatio,
    },
    momentum: {
      priceChange1h,
      priceChange4h,
    },
    regime,
    confidence,
  };
};

/**
 * Detect market regime: trending-up, trending-down, ranging, or volatile.
 */
function detectRegime({ rsi, macd, ema9, ema21, bb, closes }) {
  const currentPrice = closes[closes.length - 1];
  const e9 = ema9[ema9.length - 1];
  const e21 = ema21[ema21.length - 1];
  const bbWidth = bb.upper && bb.lower ? (bb.upper - bb.lower) / bb.middle : 0;

  if (bbWidth > 0.06) return 'volatile';
  if (e9 > e21 && rsi > 50 && macd.histogram > 0) return 'trending_up';
  if (e9 < e21 && rsi < 50 && macd.histogram < 0) return 'trending_down';
  return 'ranging';
}

/**
 * Compute a composite confidence score (0–1).
 */
function computeConfidence({ rsi, macd, regime, volumeRatio, stochastic }) {
  let score = 0.5;

  // RSI signals
  if (rsi < 30) score += 0.15;       // oversold → bullish
  else if (rsi > 70) score -= 0.15;  // overbought → bearish
  else if (rsi > 45 && rsi < 55) score += 0.05; // neutral is slightly positive

  // MACD signals
  if (macd.histogram > 0 && macd.MACD > macd.signal) score += 0.1;
  if (macd.histogram < 0 && macd.MACD < macd.signal) score -= 0.1;

  // Regime bonus
  if (regime === 'trending_up') score += 0.1;
  if (regime === 'trending_down') score -= 0.1;
  if (regime === 'volatile') score -= 0.05;

  // Volume confirmation
  if (volumeRatio > 1.5) score += 0.05;
  if (volumeRatio < 0.5) score -= 0.05;

  // Stochastic
  if (stochastic.k < 20) score += 0.05;
  if (stochastic.k > 80) score -= 0.05;

  return Math.max(0, Math.min(1, score));
}

/**
 * Generate a technical signal (BUY / SELL / HOLD) from indicators.
 */
export const generateTechnicalSignal = (indicators) => {
  if (indicators.error) return { action: 'HOLD', confidence: 0, reason: indicators.error };

  const { confidence, regime, rsi, macd } = indicators;

  if (confidence >= 0.65 && regime === 'trending_up') {
    return {
      action: 'BUY',
      confidence,
      reason: `Trending up: RSI=${rsi?.toFixed(1)}, MACD histogram positive, confidence=${confidence.toFixed(2)}`,
    };
  }

  if (confidence <= 0.35 && regime === 'trending_down') {
    return {
      action: 'SELL',
      confidence: 1 - confidence,
      reason: `Trending down: RSI=${rsi?.toFixed(1)}, MACD histogram negative, confidence=${(1 - confidence).toFixed(2)}`,
    };
  }

  return {
    action: 'HOLD',
    confidence,
    reason: `Market ${regime}: RSI=${rsi?.toFixed(1)}, insufficient conviction (confidence=${confidence.toFixed(2)})`,
  };
};

export default { computeIndicators, generateTechnicalSignal };
