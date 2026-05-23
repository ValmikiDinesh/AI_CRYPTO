import express from 'express';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';
import Portfolio from '../models/Portfolio.js';
import { publishEvent, CHANNELS } from '../config/redis.js';

const router = express.Router();

// GET /api/trades — list trades
router.get('/', async (req, res, next) => {
  try {
    const { status, asset, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (asset) filter.asset = asset;

    const trades = await Trade.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Trade.countDocuments(filter);

    res.json({
      success: true,
      data: trades,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/trades/stats — aggregated trade statistics
router.get('/stats', async (req, res, next) => {
  try {
    const [stats] = await Trade.aggregate([
      { $match: { status: 'closed' } },
      {
        $group: {
          _id: null,
          totalTrades: { $sum: 1 },
          totalPnl: { $sum: '$pnl' },
          avgPnl: { $avg: '$pnl' },
          winners: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          losers: { $sum: { $cond: [{ $lt: ['$pnl', 0] }, 1, 0] } },
          avgConfidence: { $avg: '$confidence' },
          bestTrade: { $max: '$pnl' },
          worstTrade: { $min: '$pnl' },
        },
      },
    ]);

    res.json({
      success: true,
      data: stats || {
        totalTrades: 0, totalPnl: 0, avgPnl: 0,
        winners: 0, losers: 0, avgConfidence: 0,
        bestTrade: 0, worstTrade: 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/trades/signals — latest signals
router.get('/signals', async (req, res, next) => {
  try {
    const { source, limit = 20 } = req.query;
    const filter = {};
    if (source) filter.source = source;

    const signals = await Signal.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, data: signals });
  } catch (err) {
    next(err);
  }
});

// POST /api/trades/manual — execute manual paper order
router.post('/manual', async (req, res, next) => {
  try {
    const { asset, action, type = 'paper', side = 'long', entryPrice, quantity, stopLoss, takeProfit, leverage = 1 } = req.body;

    if (!asset || !action || !entryPrice || !quantity) {
      return res.status(400).json({ success: false, message: 'Missing required trade details' });
    }

    let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
    if (!portfolio) {
      portfolio = await Portfolio.create({
        totalBalance: 10000,
        availableBalance: 10000,
      });
    }

    const marginRequired = (entryPrice * quantity) / leverage;

    if (portfolio.availableBalance < marginRequired) {
      return res.status(400).json({ success: false, message: 'Insufficient available balance' });
    }

    // Deduct from available balance
    portfolio.availableBalance -= marginRequired;
    portfolio.totalTrades += 1;

    // Create open position in portfolio
    const newPosition = {
      asset,
      side,
      entryPrice,
      currentPrice: entryPrice,
      quantity,
      stopLoss,
      takeProfit,
      status: 'open',
      unrealizedPnl: 0,
    };
    portfolio.positions.push(newPosition);
    await portfolio.save();

    // Create trade record in DB
    const trade = await Trade.create({
      userId: portfolio.userId || null,
      asset,
      action,
      type,
      side,
      entryPrice,
      quantity,
      positionSize: ((entryPrice * quantity) / portfolio.totalBalance) * 100,
      stopLoss,
      takeProfit,
      leverage,
      confidence: 1.0, // Manual trades are 100% user-confident
      riskScore: 0.1,  // Low risk by default
      reasoning: 'User Manual execution',
      status: 'open',
      executedAt: new Date(),
      exchange: 'binance_testnet',
    });

    // Compute metrics
    const openPositions = portfolio.positions.filter((p) => p.status === 'open');
    const totalValue = openPositions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);
    portfolio.allocationBreakdown = openPositions.map((p) => ({
      asset: p.asset,
      percentage: totalValue > 0 ? ((p.currentPrice * p.quantity) / totalValue) * 100 : 0,
      value: p.currentPrice * p.quantity,
    }));
    await portfolio.save();

    // Publish WebSocket notifications
    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      tradeId: trade._id,
      asset,
      action,
      price: entryPrice,
      quantity,
      confidence: 1.0,
      status: 'executed',
    });

    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      winRate: portfolio.winRate,
      openPositions: openPositions.length,
      allocation: portfolio.allocationBreakdown,
    });

    res.json({ success: true, data: trade, portfolio });
  } catch (err) {
    next(err);
  }
});

// POST /api/trades/manual-close — manually close open position
router.post('/manual-close', async (req, res, next) => {
  try {
    const { asset, exitPrice } = req.body;

    if (!asset || !exitPrice) {
      return res.status(400).json({ success: false, message: 'Missing asset or exit price' });
    }

    let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
    if (!portfolio || !portfolio.positions) {
      return res.status(404).json({ success: false, message: 'Portfolio not found' });
    }

    const positionIndex = portfolio.positions.findIndex((p) => p.asset === asset && p.status === 'open');
    if (positionIndex === -1) {
      return res.status(404).json({ success: false, message: `No active positions found for ${asset}` });
    }

    const pos = portfolio.positions[positionIndex];
    pos.status = 'closed';
    pos.closedAt = new Date();

    let pnl = 0;
    if (pos.side === 'long') {
      pnl = (exitPrice - pos.entryPrice) * pos.quantity;
    } else {
      pnl = (pos.entryPrice - exitPrice) * pos.quantity;
    }

    pos.realizedPnl = pnl;
    pos.unrealizedPnl = 0;

    // Refund capital and PnL to availableBalance
    const capitalCost = pos.entryPrice * pos.quantity;
    portfolio.availableBalance += (capitalCost + pnl);
    portfolio.totalPnl += pnl;

    if (pnl >= 0) {
      portfolio.winningTrades += 1;
    } else {
      portfolio.losingTrades += 1;
    }

    if (portfolio.totalTrades > 0) {
      portfolio.winRate = portfolio.winningTrades / portfolio.totalTrades;
    }

    portfolio.positions[positionIndex] = pos;
    await portfolio.save();

    // Close in trade DB
    const trade = await Trade.findOneAndUpdate(
      { asset, status: 'open' },
      {
        status: 'closed',
        exitPrice,
        pnl,
        closedAt: new Date(),
        metadata: { closeReason: 'Manually closed by user' },
      },
      { new: true }
    );

    // Compute metrics
    const openPositions = portfolio.positions.filter((p) => p.status === 'open');
    const totalValue = openPositions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);
    portfolio.allocationBreakdown = openPositions.map((p) => ({
      asset: p.asset,
      percentage: totalValue > 0 ? ((p.currentPrice * p.quantity) / totalValue) * 100 : 0,
      value: p.currentPrice * p.quantity,
    }));
    await portfolio.save();

    // Publish WebSocket notifications
    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      asset,
      action: 'CLOSE',
      price: exitPrice,
      pnl,
      reason: 'Manually closed by user',
    });

    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      winRate: portfolio.winRate,
      openPositions: openPositions.length,
      allocation: portfolio.allocationBreakdown,
    });

    res.json({ success: true, data: trade, portfolio });
  } catch (err) {
    next(err);
  }
});

// GET /api/trades/:id — single trade detail
router.get('/:id', async (req, res, next) => {
  try {
    const trade = await Trade.findById(req.params.id);
    if (!trade) {
      return res.status(404).json({ success: false, message: 'Trade not found' });
    }
    res.json({ success: true, data: trade });
  } catch (err) {
    next(err);
  }
});

export default router;
