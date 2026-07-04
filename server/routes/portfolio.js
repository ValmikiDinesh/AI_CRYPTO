import express from 'express';
import Portfolio from '../models/Portfolio.js';
import { SYSTEM_USER_ID } from '../config/constants.js';

const router = express.Router();

// GET /api/portfolio — current portfolio overview
router.get('/', async (req, res, next) => {
  try {
    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });

    if (!portfolio) {
      portfolio = await Portfolio.create({
        userId: SYSTEM_USER_ID,
        totalBalance: 1000,
        availableBalance: 1000,
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
      // PnL % relative to the reset capital ($1000)
      totalPnlPercent = (netPnl / 1000) * 100;
      dailyPnl = netDailyPnl;
    }

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
        openPositions: portfolio.positions.filter((p) => p.status === 'open').length,
        walletBalance: portfolio.walletBalance,
        tradingPaused: portfolio.tradingPaused,
        targetProfitThreshold: portfolio.targetProfitThreshold,
        baseTradingCapital: portfolio.baseTradingCapital,
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
      targetProfitThreshold: portfolio.targetProfitThreshold || 1100,
      baseTradingCapital: portfolio.baseTradingCapital || 1000,
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

    res.json({ success: true, message: `Asset ${asset} status updated`, data: portfolio });
  } catch (err) {
    next(err);
  }
});

export default router;
