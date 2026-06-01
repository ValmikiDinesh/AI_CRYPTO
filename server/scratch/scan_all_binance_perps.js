import { getExchange } from '../services/exchangeService.js';
import { computeIndicators, generateTechnicalSignal } from '../services/indicatorService.js';
import { SUPPORTED_ASSETS } from '../config/constants.js';
import axios from 'axios';
import 'dotenv/config';

// Sentiment keywords and helpers
const bullishKeywords = [
  'bullish', 'surge', 'rally', 'breakout', 'moon', 'pump', 'buy',
  'adoption', 'partnership', 'upgrade', 'growth', 'institutional',
  'etf', 'approval', 'record high', 'ath', 'all-time high', 'gains',
];
const bearishKeywords = [
  'bearish', 'crash', 'dump', 'selloff', 'sell-off', 'plunge', 'drop',
  'hack', 'ban', 'regulation', 'warning', 'fraud', 'scam', 'collapse',
  'fear', 'panic', 'liquidation', 'decline', 'risk',
];

function getAssetNameFull(baseAsset) {
  const names = {
    btc: 'bitcoin', eth: 'ethereum', bnb: 'binance', sol: 'solana',
    xrp: 'ripple', doge: 'dogecoin', ada: 'cardano', link: 'chainlink',
    shib: 'shiba', pepe: 'pepe', wif: 'dogwifhat', floki: 'floki',
    bonk: 'bonk', avax: 'avalanche', dot: 'polkadot', pol: 'polygon',
    ltc: 'litecoin',
  };
  return names[baseAsset] || baseAsset;
}

function analyzeSentimentForAsset(articles, baseAsset) {
  if (!Array.isArray(articles)) {
    return { score: 0, label: 'neutral', confidence: 0.3, articleCount: 0 };
  }

  const cleanAsset = baseAsset.toLowerCase();
  const searchTerms = [cleanAsset, getAssetNameFull(cleanAsset)].filter(Boolean);

  const relevant = articles.filter((article) => {
    const title = (article.title || '').toLowerCase();
    const body = (article.body || '').toLowerCase();
    const categories = (article.categories || '').toLowerCase().split('|');
    const tags = (article.tags || '').toLowerCase().split('|');

    return searchTerms.some((term) => {
      // Regex word-boundary match (fixed!)
      const regex = new RegExp(`\\b${term}\\b`, 'i');
      return (
        regex.test(title) || 
        regex.test(body) ||
        categories.includes(term) ||
        tags.includes(term)
      );
    });
  });

  if (!relevant.length) {
    return { score: 0, label: 'neutral', confidence: 0.3, articleCount: 0 };
  }

  let totalScore = 0;
  for (const article of relevant) {
    const text = `${article.title || ''} ${article.body || ''}`.toLowerCase();
    let articleScore = 0;
    for (const kw of bullishKeywords) {
      if (text.includes(kw)) articleScore += 1;
    }
    for (const kw of bearishKeywords) {
      if (text.includes(kw)) articleScore -= 1;
    }
    totalScore += articleScore;
  }

  const score = Math.max(-1, Math.min(1, totalScore / (relevant.length * 2)));
  const confidence = Math.min(0.9, 0.3 + relevant.length * 0.03);
  const label = score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral';

  return { score, label, confidence, articleCount: relevant.length };
}

function predictPriceDirection(candles) {
  const closes = candles.map((c) => c.close);
  const current = closes[closes.length - 1];

  const shortMomentum = (current - closes[closes.length - 6]) / closes[closes.length - 6];
  const medMomentum = closes.length >= 21
    ? (current - closes[closes.length - 21]) / closes[closes.length - 21]
    : 0;

  const returns = [];
  for (let i = Math.max(1, closes.length - 20); i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance);

  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const deviation = (current - sma20) / sma20;

  let score = 0;
  score += shortMomentum * 0.3;
  score += medMomentum * 0.2;
  score -= deviation * 0.3;
  score -= volatility * 0.2;

  const probability = 1 / (1 + Math.exp(-score * 50));

  let direction = 'neutral';
  if (probability > 0.55) direction = 'up';
  else if (probability < 0.45) direction = 'down';

  return {
    direction,
    probability: direction === 'down' ? 1 - probability : probability,
  };
}

function actionToScore(action) {
  if (action === 'BUY') return 1;
  if (action === 'SELL') return -1;
  return 0;
}

async function run() {
  console.log('🚀 INITIALIZING DEEP SCAN FOR ALL BINANCE FUTURES MARKETS...');
  
  // 1. Fetch news articles once
  let newsArticles = [];
  try {
    const apiKey = process.env.CRYPTOCOMPARE_API_KEY;
    const headers = apiKey ? { Authorization: `Apikey ${apiKey}` } : {};
    console.log('Fetching latest news from CryptoCompare...');
    const response = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=50', { headers, timeout: 10000 });
    if (response.data && Array.isArray(response.data.Data)) {
      newsArticles = response.data.Data;
      console.log(`✅ Loaded ${newsArticles.length} latest news articles`);
    }
  } catch (err) {
    console.warn(`⚠️ News fetch failed: ${err.message}. Sentiment defaults to neutral.`);
  }

  // 2. Fetch all tickers from Binance Futures
  const exchange = getExchange();
  console.log('🔄 Loading markets and tickers from Binance...');
  const tickers = await exchange.fetchTickers();
  const markets = await exchange.loadMarkets();
  
  // Filter active USDT perps/futures
  const targetMarkets = Object.values(markets)
    .filter(m => m.active && m.quote === 'USDT' && (m.contract || m.type === 'swap' || m.type === 'future'))
    .map(m => {
      const ticker = tickers[m.symbol] || {};
      return {
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        cleanName: m.base + m.quote,
        volume24h: ticker.quoteVolume || 0,
        price: ticker.close || ticker.last || 0,
      };
    });
  
  // Sort by volume descending
  targetMarkets.sort((a, b) => b.volume24h - a.volume24h);
  
  // Limit to top 100 highest-volume perps for fast, clean, liquid execution
  const topTargetMarkets = targetMarkets.slice(0, 100);
  
  console.log(`\n📋 SCAN TARGETS ESTABLISHED: Total of ${topTargetMarkets.length} high-volume active USDT perp markets`);
  
  // 3. Scan each market
  const defaultWeights = { technical: 0.40, sentiment: 0.20, prediction: 0.30, momentum: 0.10 };
  const matches = [];
  
  console.log('\n🔍 SCANNING OHLCV AND RUNNING MULTI-AGENT FUSION (>= 50% Confidence)...');
  
  for (let i = 0; i < topTargetMarkets.length; i++) {
    const target = topTargetMarkets[i];
    const assetClean = target.cleanName;
    const progress = `[${i + 1}/${topTargetMarkets.length}]`;
    
    try {
      // Fetch OHLCV (5m timeframe, 100 candles limit)
      const rawOhlcv = await exchange.fetchOHLCV(target.symbol, '5m', undefined, 100);
      const candles = rawOhlcv.map(([timestamp, open, high, low, close, volume]) => ({
        open, high, low, close, volume,
        openTime: new Date(timestamp),
        closeTime: new Date(timestamp + 5 * 60 * 1000 - 1),
        isClosed: true,
      }));
      
      if (candles.length < 30) continue;
      
      // Technical Agent
      const indicators = computeIndicators(candles);
      if (indicators.error) continue;
      const techSignal = generateTechnicalSignal(indicators);
      
      // Sentiment Agent (with word boundary regex fix)
      const sentiment = analyzeSentimentForAsset(newsArticles, target.base);
      
      // Prediction Agent
      const prediction = predictPriceDirection(candles);
      
      // Fusion Agent scoring
      const techScore = actionToScore(techSignal.action) * (techSignal.confidence || 0.5);
      const sentScore = sentiment.score * (sentiment.confidence || 0.5);
      const predScore = (prediction.direction === 'up' ? 1 : prediction.direction === 'down' ? -1 : 0) * prediction.probability;
      
      const momentumScore = indicators.momentum?.priceChange1h
        ? Math.max(-1, Math.min(1, indicators.momentum.priceChange1h / 5))
        : 0;
        
      const composite = 
        techScore * defaultWeights.technical +
        sentScore * defaultWeights.sentiment +
        predScore * defaultWeights.prediction +
        momentumScore * defaultWeights.momentum;
        
      const fusedConfidence = Math.abs(composite);
      
      let fusedAction = 'HOLD';
      if (composite > 0.15 && fusedConfidence >= 0.30) fusedAction = 'BUY';
      else if (composite < -0.15 && fusedConfidence >= 0.30) fusedAction = 'SELL';
      
      if (fusedConfidence >= 0.50 && fusedAction !== 'HOLD') {
        const resultObj = {
          symbol: target.symbol,
          cleanName: assetClean,
          price: target.price,
          volume24h: target.volume24h,
          action: fusedAction,
          confidence: fusedConfidence,
          technical: `${techSignal.action} (${(techSignal.confidence * 100).toFixed(0)}%)`,
          sentiment: `${sentiment.label.toUpperCase()} (${(sentiment.confidence * 100).toFixed(0)}%, articles: ${sentiment.articleCount})`,
          prediction: `${prediction.direction.toUpperCase()} (${(prediction.probability * 100).toFixed(0)}%)`
        };
        matches.push(resultObj);
        console.log(`✨ [${fusedAction}] ${target.symbol} | Fused Conf: ${(fusedConfidence * 100).toFixed(1)}%`);
      }
      
      // Speed up execution, avoid rate limits (25ms sleep)
      await new Promise(resolve => setTimeout(resolve, 25));
      
    } catch (err) {
      // Quietly ignore errors to avoid terminal clutter
    }
  }
  
  console.log('\n======================================================');
  console.log(`🎯 SCAN COMPLETE! Found ${matches.length} markets with >= 50% confidence.`);
  console.log('======================================================\n');
  
  // Sort matches by confidence level descending
  matches.sort((a, b) => b.confidence - a.confidence);
  
  console.log(JSON.stringify(matches, null, 2));
}

run().catch(console.error);
