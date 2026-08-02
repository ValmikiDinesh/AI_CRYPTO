import express from 'express';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { SYSTEM_USER_ID, CORE_ASSETS, MEME_ASSETS } from '../config/constants.js';
import { sendTelegramMessage } from '../services/telegramService.js';
import { fetchOpenOrders } from '../services/exchangeService.js';

const router = express.Router();

let portfolioAgentRef = null;
export const setPortfolioAgentRef = (agent) => {
  portfolioAgentRef = agent;
};

// GET /api/portfolio/sync-closed-trades — trigger exchange closed trades sync in non-blocking background
router.get('/sync-closed-trades', (req, res, next) => {
  try {
    if (portfolioAgentRef) {
      setImmediate(() => {
        portfolioAgentRef.syncClosedTradesFromExchange().catch(() => {});
      });
    }
    res.json({ success: true, message: 'Exchange closed trades sync initiated in background.' });
  } catch (err) {
    next(err);
  }
});

let cachedAllDataResponse = null;
let lastAllDataCacheTime = 0;
let isRefreshingAllData = false;
const ALL_DATA_CACHE_TTL_MS = 3000;

async function refreshAllDataCache() {
  if (isRefreshingAllData) return;
  isRefreshingAllData = true;
  try {
    const tradeFilter = {};
    tradeFilter.exchangeOrderId = { $exists: true, $ne: null };

    const matchStage = { status: 'closed' };
    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      matchStage.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
    }

    const [portfolioDoc, rawClosedTrades, openTrades, statsAggregation, allRiskTrades] = await Promise.all([
      Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean().then(p => p || Portfolio.findOne({}).lean()),
      Trade.find({ ...tradeFilter, status: 'closed' }).sort({ createdAt: -1 }).limit(150).lean(),
      Trade.find({ ...tradeFilter, status: 'open' }).sort({ createdAt: -1 }).limit(200).lean(),
      Trade.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalTrades: { $sum: 1 },
            totalPnl: { $sum: '$pnl' },
            avgPnl: { $avg: '$pnl' },
            winners: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
            losers: { $sum: { $cond: [{ $lt: ['$pnl', 0] }, 1, 0] } },
            grossProfit: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, '$pnl', 0] } },
            grossLoss: { $sum: { $cond: [{ $lt: ['$pnl', 0] }, '$pnl', 0] } },
            avgConfidence: { $avg: '$confidence' },
            bestTrade: { $max: '$pnl' },
            worstTrade: { $min: '$pnl' },
          },
        },
      ]),
      Trade.find(matchStage).sort({ closedAt: 1, createdAt: 1 }).limit(10000).select('pnl').lean()
    ]);

    // Filter out standalone SL/TP trigger safeguard orders (SL/TP trigger orders are safeguard orders, not closed position trades)
    const closedTrades = (rawClosedTrades || []).filter(t => {
      if (!t || t.status !== 'closed') return false;
      const isStandaloneSlTpTrigger = 
        (t.reasoning && (
          t.reasoning.includes('Native Stop-Loss') ||
          t.reasoning.includes('Native Take-Profit') ||
          t.reasoning.includes('Stop-Loss Triggered') ||
          t.reasoning.includes('Take-Profit Triggered') ||
          t.reasoning.includes('Safeguard')
        )) ||
        (t.metadata && t.metadata.isSlTpOrder === true) ||
        (t.entryPrice && t.exitPrice && Math.abs(t.entryPrice - t.exitPrice) < 0.000001 && (t.reasoning?.includes('Trigger') || t.reasoning?.includes('Stop')));
      return !isStandaloneSlTpTrigger;
    });

    let portfolio = portfolioDoc || {
      userId: SYSTEM_USER_ID,
      totalBalance: 100,
      availableBalance: 100,
      positions: []
    };

    if (portfolio && portfolio.positions) {
      const seenAssets = new Set();
      portfolio.positions = portfolio.positions.filter((pos) => {
        if (pos && pos.status === 'open') {
          if (seenAssets.has(pos.asset)) return false;
          seenAssets.add(pos.asset);
        }
        return true;
      }).map(pos => {
        if (pos && pos.status === 'open') {
          let curPrice = pos.currentPrice || pos.entryPrice || 0;
          if (portfolioAgentRef && portfolioAgentRef.marketAgent) {
            const livePrice = portfolioAgentRef.marketAgent.getPrice(pos.asset);
            if (livePrice && livePrice > 0) curPrice = livePrice;
          }
          const isLong = pos.side === 'long' || pos.action === 'BUY';
          const unrealizedPnl = isLong
            ? (curPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - curPrice) * pos.quantity;
          return { ...pos, currentPrice: curPrice, unrealizedPnl };
        }
        return pos;
      });
    }

    let liveOpenOrders = [];
    try {
      liveOpenOrders = await fetchOpenOrders();
    } catch (e) {}

    const combinedTrades = [...closedTrades, ...openTrades];
    let stats = statsAggregation[0] || {
      totalTrades: 0, totalPnl: 0, avgPnl: 0,
      winners: 0, losers: 0, grossProfit: 0, grossLoss: 0,
      avgConfidence: 0, bestTrade: 0, worstTrade: 0,
    };

    // Calculate Advanced Risk Metrics
    let maxDrawdown = 0;
    let peakEquity = 0;
    let currentEquity = 0;
    
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    
    const returns = [];
    const downsideReturns = [];
    
    allRiskTrades.forEach(t => {
      const pnl = t.pnl || 0;
      currentEquity += pnl;
      
      // Drawdown Math
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const drawdown = peakEquity - currentEquity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      
      // Streaks Math
      if (pnl > 0) {
        currentWinStreak++;
        currentLossStreak = 0;
        if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
      } else if (pnl < 0) {
        currentLossStreak++;
        currentWinStreak = 0;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      }
      
      // Return Math (for Sharpe/Sortino) - using simple nominal PnL as return proxy
      returns.push(pnl);
      if (pnl < 0) downsideReturns.push(pnl);
    });

    const meanReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const returnVariance = returns.length ? returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length : 0;
    const returnStdDev = Math.sqrt(returnVariance);
    
    const downsideVariance = downsideReturns.length ? downsideReturns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length : 0;
    const downsideStdDev = Math.sqrt(downsideVariance);

    // Assuming Risk Free Rate = 0 for crypto short-term trades
    let sharpeRatio = returnStdDev > 0 ? (meanReturn / returnStdDev) * Math.sqrt(allRiskTrades.length > 252 ? 252 : allRiskTrades.length) : 0;
    let sortinoRatio = downsideStdDev > 0 ? (meanReturn / downsideStdDev) * Math.sqrt(allRiskTrades.length > 252 ? 252 : allRiskTrades.length) : 0;
    
    let profitFactor = Math.abs(stats.grossLoss) > 0 ? (stats.grossProfit / Math.abs(stats.grossLoss)) : (stats.grossProfit > 0 ? 99.99 : 0);
    const avgWin = stats.winners > 0 ? (stats.grossProfit / stats.winners) : 0;
    const avgLoss = stats.losers > 0 ? (Math.abs(stats.grossLoss) / stats.losers) : 0;

    // Defensive NaN/Infinity fallback checks
    if (Number.isNaN(sharpeRatio) || !Number.isFinite(sharpeRatio)) sharpeRatio = 0;
    if (Number.isNaN(sortinoRatio) || !Number.isFinite(sortinoRatio)) sortinoRatio = 0;
    if (Number.isNaN(profitFactor) || !Number.isFinite(profitFactor)) profitFactor = 0;

    stats = {
      ...stats,
      maxDrawdown,
      maxWinStreak,
      maxLossStreak,
      sharpeRatio,
      sortinoRatio,
      profitFactor,
      avgWin,
      avgLoss
    };

    cachedAllDataResponse = {
      success: true,
      data: {
        portfolio,
        allTrades: combinedTrades,
        closedTrades,
        openTrades,
        openOrders: liveOpenOrders,
        stats
      }
    };
    lastAllDataCacheTime = Date.now();
  } catch (err) {
    console.error(`refreshAllDataCache error: ${err.message}`);
  } finally {
    isRefreshingAllData = false;
  }
}

// GET /api/portfolio/all-data — instant stale-while-revalidate payload for portfolio page
router.get('/all-data', async (req, res, next) => {
  try {
    if (cachedAllDataResponse) {
      res.json(cachedAllDataResponse);
      if (Date.now() - lastAllDataCacheTime >= ALL_DATA_CACHE_TTL_MS) {
        refreshAllDataCache();
      }
      return;
    }

    await refreshAllDataCache();
    res.json(cachedAllDataResponse || { success: true, data: { portfolio: {}, allTrades: [], closedTrades: [], openTrades: [], stats: {} } });
  } catch (err) {
    next(err);
  }
});

let cachedPortfolioPayload = null;
let lastPortfolioCacheTime = 0;
const PORTFOLIO_CACHE_TTL_MS = 500;

// GET /api/portfolio — current portfolio overview
router.get('/', async (req, res, next) => {
  try {
    if (cachedPortfolioPayload && (Date.now() - lastPortfolioCacheTime < PORTFOLIO_CACHE_TTL_MS)) {
      return res.json(cachedPortfolioPayload);
    }

    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
    if (!portfolio) {
      portfolio = await Portfolio.findOne({});
      if (portfolio) {
        portfolio.userId = SYSTEM_USER_ID;
        await portfolio.save();
      }
    }

    if (!portfolio) {
      const targetPct = parseFloat(process.env.BASKET_PROFIT_TARGET) || 10;
      portfolio = await Portfolio.create({
        userId: SYSTEM_USER_ID,
        totalBalance: 100,
        availableBalance: 100,
        baseTradingCapital: 100,
        peakBalance: 100,
        basketProfitTargetPct: targetPct,
        targetProfitThreshold: 100 * (1 + targetPct / 100),
      });
    }

    // Return cached portfolio object instantly (portfolioAgent background loop handles positions updates)

    // Enrich open positions with live prices and unrealized PnL from MarketAgent
    if (portfolio && portfolio.positions) {
      const seenAssets = new Set();
      portfolio.positions = portfolio.positions.filter((pos) => {
        if (pos && pos.status === 'open') {
          if (seenAssets.has(pos.asset)) return false;
          seenAssets.add(pos.asset);
        }
        return true;
      }).map(pos => {
        if (pos && pos.status === 'open') {
          let curPrice = pos.currentPrice || pos.entryPrice || 0;
          if (portfolioAgentRef && portfolioAgentRef.marketAgent) {
            const livePrice = portfolioAgentRef.marketAgent.getPrice(pos.asset);
            if (livePrice && livePrice > 0) curPrice = livePrice;
          }
          const isLong = pos.side === 'long' || pos.action === 'BUY';
          const unrealizedPnl = isLong
            ? (curPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - curPrice) * pos.quantity;
          return { ...pos, currentPrice: curPrice, unrealizedPnl };
        }
        return pos;
      });
    }

    const payload = { success: true, data: portfolio };
    cachedPortfolioPayload = payload;
    lastPortfolioCacheTime = Date.now();

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

let cachedPositionsResponse = null;
let lastPositionsCacheTime = 0;
const POSITIONS_CACHE_TTL_MS = 500;

// GET /api/portfolio/positions — open positions only
router.get('/positions', async (req, res, next) => {
  try {
    if (cachedPositionsResponse && (Date.now() - lastPositionsCacheTime < POSITIONS_CACHE_TTL_MS)) {
      return res.json(cachedPositionsResponse);
    }
    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
    if (!portfolio) {
      portfolio = await Portfolio.findOne({}).lean();
    }

    const openPositions = portfolio?.positions?.filter((p) => p.status === 'open') || [];

    const responsePayload = { success: true, data: openPositions };
    cachedPositionsResponse = responsePayload;
    lastPositionsCacheTime = Date.now();

    res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

let cachedPerformanceResponse = null;
let lastPerformanceCacheTime = 0;
const PERFORMANCE_CACHE_TTL_MS = 500;

// GET /api/portfolio/performance — performance metrics
router.get('/performance', async (req, res, next) => {
  try {
    if (cachedPerformanceResponse && (Date.now() - lastPerformanceCacheTime < PERFORMANCE_CACHE_TTL_MS)) {
      return res.json(cachedPerformanceResponse);
    }
    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
    if (!portfolio) {
      portfolio = await Portfolio.findOne({}).lean();
    }

    if (!portfolio) {
      return res.json({
        success: true,
        data: { totalPnl: 0, totalPnlPercent: 0, winRate: 0, drawdown: 0 },
      });
    }

    // Dynamic stats override since reset timestamp
    let totalPnl = portfolio.totalPnl;
    let winRate = portfolio.winRate;
    let totalTrades = portfolio.totalTrades;
    let winningTrades = portfolio.winningTrades;
    let losingTrades = portfolio.losingTrades;
    let totalPnlPercent = portfolio.totalPnlPercent;
    let dailyPnl = portfolio.dailyLossToday;

    let liveTotalBalance = portfolio.totalBalance;
    let liveAvailableBalance = portfolio.availableBalance;

    if (portfolioAgentRef && portfolioAgentRef._cachedLiveBalance) {
      liveTotalBalance = portfolioAgentRef._cachedLiveBalance.total || liveTotalBalance;
      liveAvailableBalance = portfolioAgentRef._cachedLiveBalance.free || liveAvailableBalance;
    }

    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP);
      const Trade = (await import('../models/Trade.js')).default;
      const trades = await Trade.find({
        createdAt: { $gte: resetDate },
        status: 'closed'
      }).select('pnl fees closedAt').lean();

      totalTrades = trades.length;
      winningTrades = 0;
      losingTrades = 0;
      let netPnl = 0;
      let netDailyPnl = 0;

      // Get starting of today in IST (UTC+5.5) just like the agents do
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
      const startOfToday = new Date(`${todayStr}T00:00:00.000+05:30`);

      trades.forEach(t => {
        const tradeNet = (t.pnl || 0) - (t.fees || 0);
        netPnl += tradeNet;
        if (tradeNet >= 0) winningTrades++;
        else losingTrades++;

        // If trade was closed today, add to daily PnL
        if (t.closedAt && new Date(t.closedAt) >= startOfToday) {
          netDailyPnl += tradeNet;
        }
      });

      totalPnl = netPnl;
      winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
      // PnL % relative to the reset capital
      totalPnlPercent = (netPnl / (portfolio.baseTradingCapital || 100)) * 100;
      dailyPnl = netDailyPnl;
    }

    const openPositionsCount = portfolio.positions ? portfolio.positions.filter(p => p && p.status === 'open').length : 0;

    const liveEnrichedPositions = (portfolio.positions || []).map(pos => {
      if (pos && pos.status === 'open') {
        let curPrice = pos.currentPrice || pos.entryPrice || 0;
        if (portfolioAgentRef && portfolioAgentRef.marketAgent) {
          const livePrice = portfolioAgentRef.marketAgent.getPrice(pos.asset);
          if (livePrice && livePrice > 0) curPrice = livePrice;
        }
        const isLong = pos.side === 'long' || pos.action === 'BUY';
        const unrealizedPnl = isLong
          ? (curPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - curPrice) * pos.quantity;
        return { ...pos, currentPrice: curPrice, unrealizedPnl };
      }
      return pos;
    });

    const responsePayload = {
      success: true,
      data: {
        totalBalance: liveTotalBalance,
        availableBalance: liveAvailableBalance,
        totalPnl,
        totalPnlPercent,
        dailyPnl,
        winRate,
        totalTrades,
        winningTrades,
        losingTrades,
        drawdown: portfolio.currentDrawdown,
        peakBalance: portfolio.peakBalance,
        allocation: portfolio.allocationBreakdown,
        positions: liveEnrichedPositions,
        openPositions: openPositionsCount,
        walletBalance: portfolio.walletBalance,
        tradingPaused: portfolio.tradingPaused,
        targetProfitThreshold: portfolio.targetProfitThreshold,
        baseTradingCapital: portfolio.baseTradingCapital,
        maxDailyTrades: portfolio.maxDailyTrades !== undefined ? portfolio.maxDailyTrades : 1000,
        basketProfitTargetPct: portfolio.basketProfitTargetPct || 10,
        sweepTargetProfitPct: portfolio.sweepTargetProfitPct || 10,
        usdToInrRate: portfolio.usdToInrRate || 96.54,
        coinSwitchApiKey: portfolio.coinSwitchApiKey || "",
        coinSwitchApiSecret: portfolio.coinSwitchApiSecret || "",
        dynamicTargets: portfolio.dynamicTargets || null,
      },
    };

    cachedPerformanceResponse = responsePayload;
    lastPerformanceCacheTime = Date.now();

    res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// POST /api/portfolio/resume — resume trading bot after profit target met
router.post('/resume', async (req, res, next) => {
  try {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return res.status(404).json({ success: false, message: 'Portfolio not found' });
    }

    portfolio.tradingPaused = false;
    portfolio.isSquaringOff = false; // 🛡️ FIX: Unlock the squaring off state so the bot can actually trade again!
    portfolio.peakBalance = portfolio.totalBalance; // Reset drawdown peak tracker to current balance ($1,000)
    await portfolio.save();

    // Trigger update on WebSocket/Redis channel
    const { publishEvent, CHANNELS } = await import('../config/redis.js');
    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      dailyPnl: portfolio.dailyLossToday,
      winRate: portfolio.winRate,
      openPositions: portfolio.positions.filter((p) => p && p.status === 'open').length,
      allocation: portfolio.allocationBreakdown,
      winningTrades: portfolio.winningTrades,
      losingTrades: portfolio.losingTrades,
      totalTrades: portfolio.totalTrades,
      walletBalance: portfolio.walletBalance || 0,
      tradingPaused: portfolio.tradingPaused || false,
      targetProfitThreshold: portfolio.targetProfitThreshold || 110,
      baseTradingCapital: portfolio.baseTradingCapital || 100,
      maxDailyTrades: portfolio.maxDailyTrades !== undefined ? portfolio.maxDailyTrades : 1000,
      basketProfitTargetPct: portfolio.basketProfitTargetPct || 10,
      manuallyDisabledAssets: portfolio.manuallyDisabledAssets || [],
      autoIgnoredAssets: portfolio.autoIgnoredAssets || [],
    });

    res.json({ success: true, message: 'Trading successfully resumed', data: portfolio });
  } catch (err) {
    next(err);
  }
});

// POST /api/portfolio/toggle-asset — toggle manual asset enabled/disabled state
router.post('/toggle-asset', async (req, res, next) => {
  try {
    const { asset, enabled } = req.body;
    if (!asset) {
      return res.status(400).json({ success: false, message: 'Asset is required' });
    }

    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return res.status(404).json({ success: false, message: 'Portfolio not found' });
    }

    if (!portfolio.manuallyDisabledAssets) {
      portfolio.manuallyDisabledAssets = [];
    }

    if (enabled) {
      // Re-enable asset: remove from manuallyDisabledAssets array
      portfolio.manuallyDisabledAssets = portfolio.manuallyDisabledAssets.filter(a => a !== asset);
    } else {
      // Disable asset: add to manuallyDisabledAssets array
      if (!portfolio.manuallyDisabledAssets.includes(asset)) {
        portfolio.manuallyDisabledAssets.push(asset);
      }
    }

    await portfolio.save();

    // Trigger real-time update on WebSocket/Redis channel
    try {
      const { publishEvent, CHANNELS } = await import('../config/redis.js');
      await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
        totalBalance: portfolio.totalBalance,
        availableBalance: portfolio.availableBalance,
        totalPnl: portfolio.totalPnl,
        totalPnlPercent: portfolio.totalPnlPercent,
        dailyPnl: portfolio.dailyLossToday,
        winRate: portfolio.winRate,
        openPositions: portfolio.positions.filter((p) => p && p.status === 'open').length,
        allocation: portfolio.allocationBreakdown,
        winningTrades: portfolio.winningTrades,
        losingTrades: portfolio.losingTrades,
        totalTrades: portfolio.totalTrades,
        walletBalance: portfolio.walletBalance || 0,
        tradingPaused: portfolio.tradingPaused || false,
        targetProfitThreshold: portfolio.targetProfitThreshold || 110,
        baseTradingCapital: portfolio.baseTradingCapital || 100,
        basketProfitTargetPct: portfolio.basketProfitTargetPct || 10,
        manuallyDisabledAssets: portfolio.manuallyDisabledAssets || [],
        autoIgnoredAssets: portfolio.autoIgnoredAssets || [],
      });
    } catch (redisErr) {
      // Don't fail the response if Redis pub/sub fails
      console.error('Failed to publish portfolio update during toggle-asset:', redisErr);
    }

    res.json({ success: true, message: `Asset ${asset} status updated`, data: portfolio });
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/dynamic-targets — return current GBP and CBP per category targets
router.get('/dynamic-targets', async (req, res, next) => {
  try {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return res.status(404).json({ success: false, message: 'Portfolio not found' });
    }

    const { 
      calculateCategoryBP, 
      calculateGlobalBP, 
      calculateNetPnlForPositions 
    } = await import('../services/recalculationEngine.js');

    const openPositions = portfolio.positions?.filter(p => p.status === 'open') || [];

    // Group positions by category
    const corePositions = openPositions.filter(p => p.category === 'core');
    const memePositions = openPositions.filter(p => p.category === 'meme');
    const recPositions = openPositions.filter(p => p.category === 'recommended');

    const coreTarget = calculateCategoryBP('core', corePositions, 3.0);
    const memeTarget = calculateCategoryBP('meme', memePositions, 3.0);
    const recTarget = calculateCategoryBP('recommended', recPositions, 3.0);

    const coreNetPnl = calculateNetPnlForPositions(corePositions);
    const memeNetPnl = calculateNetPnlForPositions(memePositions);
    const recNetPnl = calculateNetPnlForPositions(recPositions);

    const gbpTarget = calculateGlobalBP(openPositions, 0, 0, null); // btc price fallbacks
    const gbpNetPnl = calculateNetPnlForPositions(openPositions);

    res.json({
      success: true,
      data: {
        gbp: { 
          target: gbpTarget, 
          currentProgress: gbpNetPnl, 
          progressPct: gbpTarget > 0 ? (gbpNetPnl / gbpTarget) * 100 : 0 
        },
        cbp: {
          core: { 
            target: coreTarget, 
            currentProgress: coreNetPnl, 
            progressPct: coreTarget > 0 ? (coreNetPnl / coreTarget) * 100 : 0 
          },
          meme: { 
            target: memeTarget, 
            currentProgress: memeNetPnl, 
            progressPct: memeTarget > 0 ? (memeNetPnl / memeTarget) * 100 : 0 
          },
          recommended: { 
            target: recTarget, 
            currentProgress: recNetPnl, 
            progressPct: recTarget > 0 ? (recNetPnl / recTarget) * 100 : 0 
          },
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/volatility-profile — return daily volatility profiles
router.get('/volatility-profile', async (req, res, next) => {
  try {
    const VolatilityHistory = (await import('../models/VolatilityHistory.js')).default;
    const history = await VolatilityHistory.find({}).sort({ date: -1 }).limit(100);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

// POST & PUT /api/portfolio/config — update portfolio configurations (base capital, profit target percentage, keys)
const handleUpdateConfig = async (req, res, next) => {
  const { logger } = await import('../utils/logger.js');
  logger.info(`[CONFIG] HTTP POST /config hit with body: ${JSON.stringify(req.body)}`);
  try {
    const { 
      baseTradingCapital, maxDailyLossPct, maxDailyTrades, basketProfitTargetPct, 
      sweepTargetProfitPct, usdToInrRate, coinSwitchApiKey, coinSwitchApiSecret, 
      minMarginFloor, telegramBotToken, telegramChatId, defaultLeverage
    } = req.body;

    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      portfolio = await Portfolio.findOne({});
    }
    if (!portfolio) {
      return res.status(404).json({ success: false, message: 'Portfolio not found' });
    }

    if (baseTradingCapital !== undefined) {
      portfolio.baseTradingCapital = parseFloat(baseTradingCapital);
    }

    if (maxDailyLossPct !== undefined) {
      portfolio.maxDailyLossPct = parseFloat(maxDailyLossPct);
    }

    if (maxDailyTrades !== undefined) {
      portfolio.maxDailyTrades = parseInt(maxDailyTrades);
    }

    if (defaultLeverage !== undefined) {
      portfolio.defaultLeverage = parseFloat(defaultLeverage);
    }

    if (minMarginFloor !== undefined) {
      portfolio.minMarginFloor = parseFloat(minMarginFloor);
    }

    if (basketProfitTargetPct !== undefined && !isNaN(parseFloat(basketProfitTargetPct))) {
      portfolio.basketProfitTargetPct = parseFloat(basketProfitTargetPct);
    }

    if (sweepTargetProfitPct !== undefined && !isNaN(parseFloat(sweepTargetProfitPct))) {
      portfolio.sweepTargetProfitPct = parseFloat(sweepTargetProfitPct);
    }

    if (usdToInrRate !== undefined) {
      portfolio.usdToInrRate = parseFloat(usdToInrRate);
    }

    if (coinSwitchApiKey !== undefined) {
      portfolio.coinSwitchApiKey = coinSwitchApiKey;
    }

    if (coinSwitchApiSecret !== undefined) {
      portfolio.coinSwitchApiSecret = coinSwitchApiSecret;
    }

    if (req.body.entryOrderType !== undefined && ['market', 'limit'].includes(req.body.entryOrderType)) {
      portfolio.entryOrderType = req.body.entryOrderType;
    }

    if (req.body.exitOrderType !== undefined && ['market', 'limit'].includes(req.body.exitOrderType)) {
      portfolio.exitOrderType = req.body.exitOrderType;
    }

    if (req.body.enableDynamicScalp !== undefined) {
      portfolio.enableDynamicScalp = !!req.body.enableDynamicScalp;
    }

    if (req.body.enableTrailingStop !== undefined) {
      portfolio.enableTrailingStop = !!req.body.enableTrailingStop;
    }

    if (req.body.enableTrailingFloor !== undefined) {
      portfolio.enableTrailingFloor = !!req.body.enableTrailingFloor;
    }

    if (telegramBotToken !== undefined) {
      portfolio.telegramBotToken = telegramBotToken;
    }

    if (telegramChatId !== undefined) {
      portfolio.telegramChatId = telegramChatId;
    }

    if (req.body.enableAILlmPredictions !== undefined) {
      portfolio.enableAILlmPredictions = !!req.body.enableAILlmPredictions;
    }

    if (req.body.aiLlmSequence && Array.isArray(req.body.aiLlmSequence)) {
      portfolio.aiLlmSequence = req.body.aiLlmSequence.map(s => s.toLowerCase().trim()).filter(Boolean);
    }

    if (req.body.aiApiKeys && typeof req.body.aiApiKeys === 'object') {
      const keys = req.body.aiApiKeys;
      portfolio.aiApiKeys = {
        gemini: Array.isArray(keys.gemini) ? keys.gemini.map(k => k.trim()).filter(Boolean) : portfolio.aiApiKeys.gemini,
        groq: Array.isArray(keys.groq) ? keys.groq.map(k => k.trim()).filter(Boolean) : portfolio.aiApiKeys.groq,
        openai: Array.isArray(keys.openai) ? keys.openai.map(k => k.trim()).filter(Boolean) : portfolio.aiApiKeys.openai,
      };
    }

    if (req.body.activeStrategy && ['trend_sniper', 'hft_scalping'].includes(req.body.activeStrategy)) {
      portfolio.activeStrategy = req.body.activeStrategy;
    }

    if (req.body.strategySettings && typeof req.body.strategySettings === 'object') {
      const s = req.body.strategySettings;
      if (s.trend_sniper) {
        let conf = s.trend_sniper.confidenceThreshold !== undefined ? parseFloat(s.trend_sniper.confidenceThreshold) : portfolio.strategySettings.trend_sniper.confidenceThreshold;
        if (isNaN(conf)) conf = portfolio.strategySettings.trend_sniper.confidenceThreshold;
        portfolio.strategySettings.trend_sniper = { confidenceThreshold: conf };
      }
      if (s.hft_scalping) {
        let conf = s.hft_scalping.confidenceThreshold !== undefined ? parseFloat(s.hft_scalping.confidenceThreshold) : portfolio.strategySettings.hft_scalping.confidenceThreshold;
        if (isNaN(conf)) conf = portfolio.strategySettings.hft_scalping.confidenceThreshold;
        portfolio.strategySettings.hft_scalping = { confidenceThreshold: conf };
      }
    }

    // Recalculate targetProfitThreshold dynamically based on Sweep Target Profit Pct
    const baseCap = portfolio.baseTradingCapital || 100;
    const sweepPct = portfolio.sweepTargetProfitPct !== undefined ? portfolio.sweepTargetProfitPct : 10;
    portfolio.targetProfitThreshold = baseCap * (1 + sweepPct / 100);

    await portfolio.save();
    cachedPortfolioPayload = null; // Invalidate cache so new settings reflect immediately

    // Send Telegram notification
    try {
      const scalpStatus = portfolio.enableDynamicScalp
        ? `✅ ON (Dynamic ATR)`
        : `OFF ❌ DISABLED`;

      const trailingSlStatus = portfolio.enableTrailingStop
        ? `✅ ON (Autonomous ATR)`
        : `OFF ❌ DISABLED`;

      const wakeUpFloorStatus = portfolio.enableTrailingFloor
        ? `✅ ON (Wait for 1.0x ATR)`
        : `OFF (Start at 0 profit)`;

      const telegramMsg = `
<b>⚙️ System Settings Updated</b>

📊 <b>Dynamic Scalp Target:</b> ${scalpStatus}
📊 <b>Autonomous Trailing Stop:</b> ${trailingSlStatus}
📊 <b>Minimum Wake-up Floor:</b> ${wakeUpFloorStatus}
💰 <b>Total Base Capital:</b> $${portfolio.baseTradingCapital?.toFixed(4)} USD
📉 <b>Max Daily Loss Limit:</b> ${portfolio.maxDailyLossPct || 20}%
📈 <b>Sweep Target Profit:</b> ${portfolio.sweepTargetProfitPct}%
📈 <b>Basket Profit Target:</b> ${portfolio.basketProfitTargetPct}%
💱 <b>USD to INR Rate:</b> ₹${portfolio.usdToInrRate || 96.54}

<i>All trading agents and risk parameters have been synchronized with these updated configurations.</i>
`.trim();
      
      // Fire-and-forget to prevent blocking the API response if Telegram API is slow
      sendTelegramMessage(telegramMsg).catch(err => {
        console.error('Failed to send Telegram notification on config update:', err.message);
      });
    } catch (tgErr) {
      console.error('Error generating Telegram notification:', tgErr);
    }

    // Trigger update on WebSocket/Redis channel
    const { publishEvent, CHANNELS } = await import('../config/redis.js');
    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      dailyPnl: portfolio.dailyLossToday,
      winRate: portfolio.winRate,
      openPositions: portfolio.positions.filter((p) => p && p.status === 'open').length,
      allocation: portfolio.allocationBreakdown,
      winningTrades: portfolio.winningTrades,
      losingTrades: portfolio.losingTrades,
      totalTrades: portfolio.totalTrades,
      walletBalance: portfolio.walletBalance || 0,
      tradingPaused: portfolio.tradingPaused || false,
      targetProfitThreshold: portfolio.targetProfitThreshold,
      baseTradingCapital: portfolio.baseTradingCapital,
      maxDailyTrades: portfolio.maxDailyTrades,
      basketProfitTargetPct: portfolio.basketProfitTargetPct,
      sweepTargetProfitPct: portfolio.sweepTargetProfitPct,
      usdToInrRate: portfolio.usdToInrRate,
      manuallyDisabledAssets: portfolio.manuallyDisabledAssets || [],
      autoIgnoredAssets: portfolio.autoIgnoredAssets || [],
      coinSwitchApiKey: portfolio.coinSwitchApiKey || "",
      coinSwitchApiSecret: portfolio.coinSwitchApiSecret || "",
      entryOrderType: portfolio.entryOrderType || "market",
      exitOrderType: portfolio.exitOrderType || "market",
      enableDynamicScalp: portfolio.enableDynamicScalp || false,
      enableTrailingStop: portfolio.enableTrailingStop !== undefined ? portfolio.enableTrailingStop : true,
      enableTrailingFloor: portfolio.enableTrailingFloor !== undefined ? portfolio.enableTrailingFloor : true,
      trailingStopUsd: (portfolio.trailingStopUsd && portfolio.trailingStopUsd > 0) ? portfolio.trailingStopUsd : null,
      trailingStopMinFloorUsd: portfolio.trailingStopMinFloorUsd || 0.10,
      enableAILlmPredictions: portfolio.enableAILlmPredictions || false,
      aiLlmSequence: portfolio.aiLlmSequence || [],
      aiApiKeys: portfolio.aiApiKeys || { gemini: [], groq: [], openai: [] },
      defaultLeverage: portfolio.defaultLeverage || 1,
      strategySettings: portfolio.strategySettings || {}
    });

    res.json({ success: true, message: 'Portfolio configuration updated successfully', data: portfolio });
  } catch (err) {
    next(err);
  }
};

router.post('/config', handleUpdateConfig);
router.put('/config', handleUpdateConfig);

// GET /api/portfolio/closed-trades - Paginated closed trades with category filter
router.get('/closed-trades', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const category = req.query.category || 'all';

    const filter = { status: 'closed' };
    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      filter.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
    }
    filter.exchangeOrderId = { $exists: true, $ne: null };

    if (category === 'core') {
      filter.asset = { $in: CORE_ASSETS };
    } else if (category === 'meme') {
      filter.asset = { $in: MEME_ASSETS };
    } else if (category === 'recommended') {
      filter.asset = { $nin: [...CORE_ASSETS, ...MEME_ASSETS] };
    }

    const skip = (page - 1) * limit;

    const [rawTrades, total] = await Promise.all([
      Trade.find(filter).sort({ closedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Trade.countDocuments(filter)
    ]);

    // Filter out standalone SL/TP trigger safeguard orders
    const trades = (rawTrades || []).filter(t => {
      if (!t || t.status !== 'closed') return false;
      const isStandaloneSlTpTrigger = 
        (t.reasoning && (
          t.reasoning.includes('Native Stop-Loss') ||
          t.reasoning.includes('Native Take-Profit') ||
          t.reasoning.includes('Stop-Loss Triggered') ||
          t.reasoning.includes('Take-Profit Triggered') ||
          t.reasoning.includes('Safeguard')
        )) ||
        (t.metadata && t.metadata.isSlTpOrder === true) ||
        (t.entryPrice && t.exitPrice && Math.abs(t.entryPrice - t.exitPrice) < 0.000001 && (t.reasoning?.includes('Trigger') || t.reasoning?.includes('Stop')));
      return !isStandaloneSlTpTrigger;
    });

    res.json({
      success: true,
      data: {
        trades,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/export - Export all closed trades as CSV
router.get('/export', async (req, res, next) => {
  try {
    const tzOffset = parseInt(req.query.tzOffset) || 0; // offset in minutes

    const filter = { status: 'closed' };
    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      filter.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
    }
    filter.exchangeOrderId = { $exists: true, $ne: null };

    const rawTrades = await Trade.find(filter).sort({ closedAt: -1 }).lean();

    // Filter out standalone SL/TP safeguard orders
    const trades = (rawTrades || []).filter(t => {
      if (!t || t.status !== 'closed') return false;
      const isStandaloneSlTpTrigger = 
        (t.reasoning && (
          t.reasoning.includes('Native Stop-Loss') ||
          t.reasoning.includes('Native Take-Profit') ||
          t.reasoning.includes('Stop-Loss Triggered') ||
          t.reasoning.includes('Take-Profit Triggered') ||
          t.reasoning.includes('Safeguard')
        )) ||
        (t.metadata && t.metadata.isSlTpOrder === true) ||
        (t.entryPrice && t.exitPrice && Math.abs(t.entryPrice - t.exitPrice) < 0.000001 && (t.reasoning?.includes('Trigger') || t.reasoning?.includes('Stop')));
      return !isStandaloneSlTpTrigger;
    });

    const csvRows = [
      ['Trade ID', 'Asset', 'Side', 'Opened At', 'Closed At', 'Entry Price', 'Exit Price', 'Quantity', 'Leverage', 'PnL (USD)', 'Fees (USD)', 'Strategy', 'Reasoning']
    ];

    const formatLocalTime = (dateObj) => {
      if (!dateObj) return '';
      // Create a date shifted by the client's tzOffset (which is in minutes, e.g., -330 for IST)
      // JS getTimezoneOffset() is UTC - LocalTime in minutes.
      const localTime = new Date(dateObj.getTime() - tzOffset * 60000);
      return localTime.toISOString().replace('Z', '');
    };

    trades.forEach(t => {
      csvRows.push([
        t._id,
        t.asset,
        t.side.toUpperCase(),
        formatLocalTime(new Date(t.createdAt)),
        formatLocalTime(t.closedAt ? new Date(t.closedAt) : null),
        t.entryPrice,
        t.exitPrice || '',
        t.quantity,
        t.leverage || 1,
        (t.pnl || 0).toFixed(4),
        (t.fees || 0).toFixed(4),
        t.activeStrategy || 'trend_sniper',
        `"${(t.reasoning || '').replace(/"/g, '""')}"`
      ]);
    });

    const csvString = csvRows.map(row => row.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="crypto_ai_ledger_export.csv"');
    res.status(200).send(csvString);
  } catch (err) {
    next(err);
  }
});

export default router;

