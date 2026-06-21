import express from 'express';
import Portfolio from '../models/Portfolio.js';

const router = express.Router();

// GET /api/portfolio — current portfolio overview
router.get('/', async (req, res, next) => {
  try {
    let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });

    if (!portfolio) {
      portfolio = await Portfolio.create({
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
    const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
    const openPositions = portfolio?.positions?.filter((p) => p.status === 'open') || [];

    res.json({ success: true, data: openPositions });
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/performance — performance metrics
router.get('/performance', async (req, res, next) => {
  try {
    const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });

    if (!portfolio) {
      return res.json({
        success: true,
        data: { totalPnl: 0, totalPnlPercent: 0, winRate: 0, drawdown: 0 },
      });
    }

    res.json({
      success: true,
      data: {
        totalBalance: portfolio.totalBalance,
        availableBalance: portfolio.availableBalance,
        totalPnl: portfolio.totalPnl,
        totalPnlPercent: portfolio.totalPnlPercent,
        dailyPnl: portfolio.dailyLossToday,
        winRate: portfolio.winRate,
        totalTrades: portfolio.totalTrades,
        winningTrades: portfolio.winningTrades,
        losingTrades: portfolio.losingTrades,
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
    const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
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

export default router;
