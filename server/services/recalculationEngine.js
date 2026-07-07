import { CORE_ASSETS, MEME_ASSETS, RECOMMENDED_ASSETS } from '../config/constants.js';

/**
 * Shared utility to determine category for an asset.
 */
export const getCategoryForAsset = (asset) => {
  const cleanAsset = asset.toUpperCase();
  if (CORE_ASSETS.includes(cleanAsset)) return 'core';
  if (MEME_ASSETS.includes(cleanAsset)) return 'meme';
  if (RECOMMENDED_ASSETS.includes(cleanAsset)) return 'recommended';
  return 'other';
};

/**
 * Universal Net PnL Calculation.
 * Deducts both the opening fee (already paid) and the estimated closing fee.
 * 
 * Formula: Net PnL = unrealizedPnl - openingFee - (currentPrice * quantity * 0.0005)
 */
export const calculateNetPnl = (position) => {
  if (!position) return 0;
  const currentPrice = position.currentPrice || position.entryPrice || 0;
  const unrealizedPnl = position.unrealizedPnl || 0;
  
  // Taker fee rate (0.05% default on exit market order)
  const TAKER_FEE_RATE = 0.0005;
  const openFee = position.fees || 0;
  const estCloseFee = currentPrice * position.quantity * TAKER_FEE_RATE;
  
  return unrealizedPnl - openFee - estCloseFee;
};

/**
 * Sum net PnL across multiple positions.
 */
export const calculateNetPnlForPositions = (positions) => {
  if (!positions || positions.length === 0) return 0;
  return positions.reduce((sum, p) => sum + calculateNetPnl(p), 0);
};

// ─── Phase 1: Dynamic Asset TP ──────────────────────────────────────────

/**
 * Calculates ATR-based trailing percentage.
 * Distant stop loss for high volatility, tighter stop loss for low volatility.
 * 
 * Formula: trailingPct = (ATR * Multiplier) / currentPrice
 */
export const calculateDynamicTrailingPct = (asset, atr, currentPrice) => {
  if (!atr || !currentPrice) {
    return 0.03; // fallback 3%
  }
  
  const multiplier = parseFloat(process.env.DYNAMIC_TP_ATR_MULTIPLIER) || 1.5;
  const category = getCategoryForAsset(asset);
  
  // Apply category specific tweaks to dynamic trailing if desired
  let categoryMod = 1.0;
  if (category === 'meme') categoryMod = 1.2;          // give memes slightly more breathing room
  if (category === 'core') categoryMod = 0.9;          // keep core assets tighter
  
  const rawTrailingPct = (atr * multiplier * categoryMod) / currentPrice;
  
  // Constrain trailingPct between 1% and 10%
  return Math.max(0.01, Math.min(0.10, rawTrailingPct));
};

/**
 * Calculate the price level where profit locking triggers.
 * E.g. once price moves up by 1.5 * ATR, we will move Stop Loss to lock min profit.
 */
export const calculateMinProfitLockPrice = (entryPrice, side, atr, targetLockPct = 0.003) => {
  if (!entryPrice || !atr) return null;
  
  const sideSign = side === 'long' ? 1 : -1;
  // min profit lock in $ (default 0.3% of entry price)
  const minProfitValue = entryPrice * targetLockPct;
  
  return entryPrice + (sideSign * minProfitValue);
};

/**
 * Check if the position's Net PnL has reached the threshold to lock minimum profit.
 * Thresold = entryPrice * lock_trigger_pct (e.g. 0.8% of entry price)
 */
export const shouldLockProfit = (position) => {
  if (!position || position.status !== 'open') return false;
  
  const entryPrice = position.entryPrice;
  const initialMargin = (entryPrice * position.quantity) / (position.leverage || 1);
  if (initialMargin <= 0) return false;
  
  const netPnl = calculateNetPnl(position);
  
  // Lock threshold: Net PnL is at least 15% of the initial margin or Net Worth is +$2.50
  const lockTriggerPnl = initialMargin * 0.15;
  
  return netPnl >= Math.max(2.5, lockTriggerPnl) && !position.lockedMinProfit;
};

/**
 * Get the updated Stop Loss price based on dynamic trailing.
 */
export const getUpdatedStopLoss = (position, currentPrice, dynamicTrailingPct) => {
  if (!position || !currentPrice) return position?.stopLoss;
  
  const trailingPct = dynamicTrailingPct || position.dynamicTrailingPct || position.trailingPct || 0.03;
  const side = position.side; // 'long' or 'short'
  const oldSL = position.stopLoss;
  
  if (side === 'long') {
    const newSL = currentPrice * (1 - trailingPct);
    // Stop loss can only move UP for long positions
    return oldSL ? Math.max(oldSL, newSL) : newSL;
  } else {
    const newSL = currentPrice * (1 + trailingPct);
    // Stop loss can only move DOWN for short positions
    return oldSL ? Math.min(oldSL, newSL) : newSL;
  }
};

// ─── Phase 2: Category Basket Profit (CBP) ──────────────────────────────

/**
 * Calculate dynamic Category Basket Profit target.
 * Dynamically scales the base target using number of open positions and average volatility.
 * 
 * Formula: CBP = BaseCategoryTarget * (Number of positions^0.7) * VolatilityMultiplier
 */
export const calculateCategoryBP = (category, openPositions, avgWeekdayRangePct = 1.0) => {
  let baseTarget = 10;
  if (category === 'core') baseTarget = parseFloat(process.env.CBP_BASE_TARGET_CORE) || 10;
  if (category === 'meme') baseTarget = parseFloat(process.env.CBP_BASE_TARGET_MEME) || 8;
  if (category === 'recommended') baseTarget = parseFloat(process.env.CBP_BASE_TARGET_RECOMMENDED) || 5;
  
  const positionCount = openPositions ? openPositions.length : 0;
  if (positionCount === 0) return 0;
  
  // Scale target with position count (more trades = higher overall profit target, but sub-linear)
  const countScale = Math.pow(positionCount, 0.7);
  
  // Weekday Volatility multiplier (relative to 3% benchmark daily range)
  const volatilityMultiplier = Math.max(0.5, Math.min(2.0, avgWeekdayRangePct / 3.0));
  
  return baseTarget * countScale * volatilityMultiplier;
};

// ─── Phase 3: Global Basket Profit (GBP) ───────────────────────────────

/**
 * Detect general market regime using BTC price and its 200 SMA.
 */
export const detectMarketRegime = (btcPrice, btc200SMA) => {
  if (!btcPrice || !btc200SMA) return 'ranging';
  
  if (btcPrice > btc200SMA * 1.02) return 'bull';
  if (btcPrice < btc200SMA * 0.98) return 'bear';
  
  return 'ranging';
};

/**
 * Calculate dynamic Global Basket Profit.
 * Integrates correlation penalties and market regime multipliers.
 */
export const calculateGlobalBP = (allPositions, btcPrice, btc200SMA, correlationMatrix = null) => {
  const baseTarget = parseFloat(process.env.GBP_BASE_TARGET) || 20;
  const positionCount = allPositions ? allPositions.length : 0;
  if (positionCount === 0) return 0;
  
  // Regime multiplier (looser in Bull, tighter/faster targets in Bear to protect assets)
  const regime = detectMarketRegime(btcPrice, btc200SMA);
  let regimeMultiplier = 1.0;
  if (regime === 'bull') regimeMultiplier = 1.25;
  if (regime === 'bear') regimeMultiplier = 0.75;
  
  // Correlation penalty: if all assets are highly correlated, we decrease the target to escape sooner
  let correlationPenalty = 1.0;
  if (correlationMatrix && correlationMatrix.avgCorrelation > 0.7) {
    correlationPenalty = 0.8; // drop target by 20% to exit fast during market-wide dump/pump
  }
  
  // Scale with position count
  const countScale = Math.pow(positionCount, 0.75);
  
  return baseTarget * countScale * regimeMultiplier * correlationPenalty;
};

/**
 * Calculate basic correlation coefficient between two price history arrays.
 */
const correlation = (x, y) => {
  const n = x.length;
  if (n === 0 || n !== y.length) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  
  let num = 0;
  let denX = 0;
  let denY = 0;
  
  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;
    num += diffX * diffY;
    denX += diffX * diffX;
    denY += diffY * diffY;
  }
  
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
};

/**
 * Calculate correlation matrix for price histories of open assets.
 */
export const calculateCorrelationMatrix = (assetPriceHistories) => {
  const assets = Object.keys(assetPriceHistories);
  if (assets.length < 2) return { matrix: {}, avgCorrelation: 0 };
  
  const matrix = {};
  let totalCorr = 0;
  let pairCount = 0;
  
  for (let i = 0; i < assets.length; i++) {
    const a1 = assets[i];
    matrix[a1] = {};
    for (let j = 0; j < assets.length; j++) {
      const a2 = assets[j];
      if (i === j) {
        matrix[a1][a2] = 1.0;
      } else {
        const corr = correlation(assetPriceHistories[a1], assetPriceHistories[a2]);
        matrix[a1][a2] = corr;
        if (i < j) {
          totalCorr += Math.abs(corr);
          pairCount++;
        }
      }
    }
  }
  
  return {
    matrix,
    avgCorrelation: pairCount > 0 ? totalCorr / pairCount : 0
  };
};

/**
 * Calculate dynamic position size based on volatility (Risk Parity).
 */
export const calculatePositionSize = (asset, atr, availableBalance, regime = 'ranging') => {
  if (!atr || !availableBalance) return 53; // default minimum notional
  
  const currentPrice = atr.price || 1; // dummy fallback
  const riskPct = parseFloat(process.env.MAX_RISK_PER_TRADE) || 0.01;
  const riskAmount = availableBalance * riskPct;
  
  // SL percent = ATR * multiplier / price
  const slPercent = (atr * 1.5) / currentPrice;
  
  // Dynamic position size based on Risk Parity
  let positionValue = slPercent > 0.001 ? (riskAmount / slPercent) : (riskAmount / 0.05);
  
  // Adjust sizing based on Market Regime
  if (regime === 'bull') positionValue *= 1.15; // slightly larger size in bull market
  if (regime === 'bear') positionValue *= 0.80; // scale down trades by 20% in bear market
  
  return positionValue;
};

export default {
  getCategoryForAsset,
  calculateNetPnl,
  calculateNetPnlForPositions,
  calculateDynamicTrailingPct,
  calculateMinProfitLockPrice,
  shouldLockProfit,
  getUpdatedStopLoss,
  calculateCategoryBP,
  detectMarketRegime,
  calculateGlobalBP,
  calculateCorrelationMatrix,
  calculatePositionSize
};
