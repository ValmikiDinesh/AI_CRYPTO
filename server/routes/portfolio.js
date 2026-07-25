import express from 'express';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import { sendTelegramMessage } from '../services/telegramService.js';

const router = express.Router();

let portfolioAgentRef = null;
export const setPortfolioAgentRef = (agent) => {
  portfolioAgentRef = agent;
};

// GET /api/portfolio/sync-closed-trades — trigger exchange closed trades sync
router.get('/sync-closed-trades', async (req, res, next) => {
  try {
    if (portfolioAgentRef) {
      await portfolioAgentRef.syncClosedTradesFromExchange();
      res.json({ success: true, message: 'Exchange closed trades synchronized successfully.' });
    } else {
      res.status(500).json({ success: false, message: 'Portfolio agent not available' });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio — current portfolio overview
router.get('/', async (req, res, next) => {
  try {
    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });

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

    // Deduplicate open positions before sending response to UI
    if (portfolio && portfolio.positions) {
      const seenAssets = new Set();
      portfolio.positions = portfolio.positions.filter((pos) => {
        if (pos && pos.status === 'open') {
          if (seenAssets.has(pos.asset)) return false;
          seenAssets.add(pos.asset);
        }
        return true;
      });
    }

    res.json({ success: true, data: portfolio });
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/positions — open positions only
router.get('/positions', async (req, res, next) => {
  try {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    const openPositions = portfolio?.positions?.filter((p) => p.status === 'open') || [];

    res.json({ success: true, data: openPositions });
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/performance — performance metrics
router.get('/performance', async (req, res, next) => {
  try {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });

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

    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP);
      const Trade = (await import('../models/Trade.js')).default;
      const trades = await Trade.find({
        createdAt: { $gte: resetDate },
        status: 'closed'
      }).lean();

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

    res.json({
      success: true,
      data: {
        totalBalance: portfolio.totalBalance,
        availableBalance: portfolio.availableBalance,
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
        positions: portfolio.positions || [],
        openPositions: openPositionsCount,
        walletBalance: portfolio.walletBalance,
        tradingPaused: portfolio.tradingPaused,
        targetProfitThreshold: portfolio.targetProfitThreshold,
        baseTradingCapital: portfolio.baseTradingCapital,
        basketProfitTargetPct: portfolio.basketProfitTargetPct || 10,
        sweepTargetProfitPct: portfolio.sweepTargetProfitPct || 10,
        usdToInrRate: portfolio.usdToInrRate || 96.54,
        coinSwitchApiKey: portfolio.coinSwitchApiKey || "",
        coinSwitchApiSecret: portfolio.coinSwitchApiSecret || "",
      },
    });
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

// POST /api/portfolio/config — update portfolio configurations (base capital, profit target percentage, keys)
router.post('/config', async (req, res, next) => {
  try {
    const { baseTradingCapital, basketProfitTargetPct, sweepTargetProfitPct, usdToInrRate, coinSwitchApiKey, coinSwitchApiSecret } = req.body;

    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return res.status(404).json({ success: false, message: 'Portfolio not found' });
    }

    if (baseTradingCapital !== undefined) {
      portfolio.baseTradingCapital = parseFloat(baseTradingCapital);
      if (process.env.TRADING_MODE !== 'live') {
        portfolio.totalBalance = parseFloat(baseTradingCapital);
        portfolio.availableBalance = parseFloat(baseTradingCapital);
        portfolio.peakBalance = parseFloat(baseTradingCapital);
      }
    }

    if (basketProfitTargetPct !== undefined) {
      portfolio.basketProfitTargetPct = parseFloat(basketProfitTargetPct);
    }

    if (sweepTargetProfitPct !== undefined) {
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

    if (req.body.minNetProfitTarget !== undefined && !isNaN(parseFloat(req.body.minNetProfitTarget))) {
      portfolio.minNetProfitTarget = parseFloat(req.body.minNetProfitTarget);
    }

    // Recalculate targetProfitThreshold dynamically based on Sweep Target Profit Pct
    const baseCap = portfolio.baseTradingCapital || 100;
    const sweepPct = portfolio.sweepTargetProfitPct !== undefined ? portfolio.sweepTargetProfitPct : 10;
    portfolio.targetProfitThreshold = baseCap * (1 + sweepPct / 100);

    await portfolio.save();

    // Send Telegram notification
    try {
      const telegramMsg = `
<b>⚙️ System Settings Updated</b>

<b>Total Base Capital:</b> $${portfolio.baseTradingCapital?.toFixed(4)} USD
<b>Sweep Target Profit:</b> ${portfolio.sweepTargetProfitPct}%
<b>Basket Profit Target:</b> ${portfolio.basketProfitTargetPct}%
<b>USD to INR Rate:</b> ₹${portfolio.usdToInrRate || 96.54}

<i>All trading agents and risk parameters have been synchronized with these updated configurations.</i>
`.trim();
      await sendTelegramMessage(telegramMsg);
    } catch (tgErr) {
      console.error('Failed to send Telegram notification on config update:', tgErr);
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
      basketProfitTargetPct: portfolio.basketProfitTargetPct,
      sweepTargetProfitPct: portfolio.sweepTargetProfitPct,
      usdToInrRate: portfolio.usdToInrRate,
      manuallyDisabledAssets: portfolio.manuallyDisabledAssets || [],
      autoIgnoredAssets: portfolio.autoIgnoredAssets || [],
      coinSwitchApiKey: portfolio.coinSwitchApiKey || "",
      coinSwitchApiSecret: portfolio.coinSwitchApiSecret || "",
      entryOrderType: portfolio.entryOrderType || "market",
      exitOrderType: portfolio.exitOrderType || "market",
      minNetProfitTarget: portfolio.minNetProfitTarget !== undefined ? portfolio.minNetProfitTarget : 0.25,
    });

    res.json({ success: true, message: 'Portfolio configuration updated successfully', data: portfolio });
  } catch (err) {
    next(err);
  }
});

export default router;

