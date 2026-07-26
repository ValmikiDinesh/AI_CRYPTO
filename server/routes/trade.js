import express from 'express';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';
import Portfolio from '../models/Portfolio.js';
import { publishEvent, CHANNELS } from '../config/redis.js';
import { sendTelegramMessage, formatPrice } from '../services/telegramService.js';
import { SYSTEM_USER_ID } from '../config/constants.js';

const router = express.Router();

// GET /api/trades — list trades
router.get('/', async (req, res, next) => {
  try {
    const { status, asset, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (asset) filter.asset = asset;

    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      filter.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
    }

    const trades = await Trade.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

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
    const matchStage = { status: 'closed' };
    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      matchStage.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
    }

    const [stats] = await Trade.aggregate([
      { $match: matchStage },
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

// GET /api/trades/performance-comparison — compare AI vs Local performance
router.get('/performance-comparison', async (req, res, next) => {
  try {
    const filter = { status: 'closed' };
    if (process.env.DASHBOARD_RESET_TIMESTAMP) {
      filter.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
    }
    const trades = await Trade.find(filter).lean();

    const stats = {
      ai: { count: 0, wins: 0, losses: 0, totalPnl: 0 },
      fallback: { count: 0, wins: 0, losses: 0, totalPnl: 0 },
      unknown: { count: 0, wins: 0, losses: 0, totalPnl: 0 }
    };

    trades.forEach(trade => {
      const source = trade.metadata?.sourceModel || 'none';
      let category = 'unknown';
      
      if (source.includes('ai_')) {
        category = 'ai';
      } else if (source.includes('fallback') || source.includes('statistical')) {
        category = 'fallback';
      }

      const pnl = trade.pnl || 0;
      const fees = trade.fees || 0;
      const netPnl = pnl - fees;

      stats[category].count++;
      stats[category].totalPnl += netPnl;

      if (netPnl > 0) {
        stats[category].wins++;
      } else if (netPnl < 0) {
        stats[category].losses++;
      }
    });

    res.json({
      success: true,
      data: stats
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

    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      portfolio = await Portfolio.create({
        userId: SYSTEM_USER_ID,
        totalBalance: 1000,
        availableBalance: 1000,
      });
    }

    if (portfolio.tradingPaused) {
      return res.status(400).json({ success: false, message: 'Trading is currently paused because the profit target has been met. Please resume the bot from the portfolio page first.' });
    }

    const hasOpenPosition = portfolio.positions?.some((p) => p.asset === asset && p.status === 'open');
    if (hasOpenPosition) {
      return res.status(400).json({ success: false, message: `Position already open for ${asset}` });
    }

    const marginRequired = (entryPrice * quantity) / leverage;
    const futuresFeeRate = 0.0005; // 0.05% Taker Fee
    const entryFee = (entryPrice * quantity) * futuresFeeRate;

    if (portfolio.availableBalance < (marginRequired + entryFee)) {
      return res.status(400).json({ success: false, message: 'Insufficient available balance to cover margin and commission fees' });
    }

    // Deduct from available balance (margin + entry fee)
    if (process.env.TRADING_MODE === 'live') {
      try {
        const { fetchBalance } = await import('../services/exchangeService.js');
        const liveBal = await fetchBalance();
        if (liveBal && liveBal.USDT) {
          portfolio.availableBalance = liveBal.USDT.free;
          portfolio.totalBalance = liveBal.USDT.total;
        }
      } catch (bErr) {}
    } else {
      portfolio.availableBalance -= (marginRequired + entryFee);
    }
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
      fees: entryFee,
      leverage,
    };
    portfolio.positions.push(newPosition);

    // Recalculate total balance using leverage-adjusted universal equity formula
    const marginValue = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

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
      fees: entryFee,
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

    // Notify Telegram
    await sendTelegramMessage(
      `🔔 <b>Manual Trade Executed!</b>\n` +
      `<b>Asset</b>: ${asset.replace('USDT', '')}/USDT\n` +
      `<b>Action</b>: ${action} (${side === 'long' ? 'LONG' : 'SHORT'})\n` +
      `<b>Entry Price</b>: $${formatPrice(entryPrice)}\n` +
      `<b>Quantity</b>: ${quantity.toFixed(5)}\n` +
      `<b>Stop Loss</b>: ${stopLoss ? '$' + formatPrice(stopLoss) : '—'}\n` +
      `<b>Target</b>: ${takeProfit ? '$' + formatPrice(takeProfit) : '—'}\n` +
      `<b>Leverage</b>: ${leverage}x`
    );

    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      winRate: portfolio.winRate,
      openPositions: openPositions.length,
      allocation: portfolio.allocationBreakdown,
      winningTrades: portfolio.winningTrades,
      losingTrades: portfolio.losingTrades,
      totalTrades: portfolio.totalTrades,
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

    // Place offsetting market close order on the exchange if it's a live/testnet trade
    let finalExitPrice = exitPrice;
    let finalExitFee = (exitPrice * pos.quantity) * 0.0005; // default 0.05% taker fee
    
    try {
      const activeTrade = await Trade.findOne({ asset, status: 'open' });
      const isLiveMode = process.env.TRADING_MODE === 'live' || !!process.env.COINSWITCH_API_KEY;
      const isMockOrder = activeTrade && activeTrade.exchangeOrderId && activeTrade.exchangeOrderId.startsWith('mock_');

      if (isLiveMode && !isMockOrder) {
        const { placeMarketOrder, cancelOrder, cancelAllOrders, getExchange } = await import('../services/exchangeService.js');
        const exitSide = pos.side === 'long' ? 'sell' : 'buy';
        
        let closeQty = pos.quantity;
        let positionExistsOnExchange = false;

        try {
          const exchange = getExchange();
          await exchange.loadMarkets();
          
          let exchangeSymbol = asset.replace('USDT', '/USDT:USDT');
          if (asset.startsWith('1000')) {
            // keep it
          } else if (asset === 'BONKUSDT' || asset === 'SHIBUSDT' || asset === 'PEPEUSDT' || asset === 'FLOKIUSDT') {
            exchangeSymbol = '1000' + asset.replace('USDT', '/USDT:USDT');
          }
          
          const positions = await exchange.fetchPositions([exchangeSymbol]);
          const activePos = positions.find(p => p.symbol === exchangeSymbol && parseFloat(p.contracts) > 0);
          if (activePos) {
            closeQty = parseFloat(activePos.contracts);
            positionExistsOnExchange = true;
          } else {
            // If fetchPositions filter by symbol didn't match, check all positions
            const allPositions = await exchange.fetchPositions();
            const matchingPos = allPositions.find(p => p.symbol.split(':')[0].replace('/', '') === asset && parseFloat(p.contracts) > 0);
            if (matchingPos) {
              closeQty = parseFloat(matchingPos.contracts);
              positionExistsOnExchange = true;
            }
          }
        } catch (fetchErr) {
          console.warn(`Failed to fetch fresh position size before exit: ${fetchErr.message}`);
          positionExistsOnExchange = true; // Fallback to executing close order
        }

        if (positionExistsOnExchange) {
          console.log(`Executing offsetting market order on exchange to close ${closeQty} contracts for ${asset}`);
          const closeOrder = await placeMarketOrder(asset, exitSide, closeQty);
          
          finalExitPrice = closeOrder.average || closeOrder.price || 0;
          if (finalExitPrice === 0) {
            try {
              const exchange = getExchange();
              let exchangeSymbol = asset.replace('USDT', '/USDT:USDT');
              if (asset.startsWith('1000')) {
                // keep it
              } else if (asset === 'BONKUSDT' || asset === 'SHIBUSDT' || asset === 'PEPEUSDT' || asset === 'FLOKIUSDT') {
                exchangeSymbol = '1000' + asset.replace('USDT', '/USDT:USDT');
              }
              const ticker = await exchange.fetchTicker(exchangeSymbol);
              finalExitPrice = ticker.last || ticker.close || exitPrice;
              console.log(`⚠️ Market order price was not returned. Used ticker price fallback for manual close: $${finalExitPrice}`);
            } catch (tickerErr) {
              finalExitPrice = exitPrice;
            }
          }
          if (closeOrder.fee && closeOrder.fee.cost) {
            finalExitFee = closeOrder.fee.cost;
          }

          // Clean up entry limit order and any remaining trigger orders on exchange
          try {
            if (activeTrade && activeTrade.exchangeOrderId) {
              try {
                await cancelOrder(asset, activeTrade.exchangeOrderId);
              } catch (orderErr) {
                console.log(`Entry limit order was already fully filled or cancelled: ${orderErr.message}`);
              }
            }
            await cancelAllOrders(asset);
          } catch (cleanErr) {
            console.warn(`Failed to clean up remaining triggers: ${cleanErr.message}`);
          }
        } else {
          console.log(`No active position found on Exchange for ${asset}. Closing position locally.`);
        }
      }
    } catch (exchangeErr) {
      return res.status(500).json({ 
        success: false, 
        message: `Failed to execute close order on exchange: ${exchangeErr.message}` 
      });
    }

    pos.status = 'closed';
    pos.closedAt = new Date();

    let pnl = 0;
    if (pos.side === 'long') {
      pnl = (finalExitPrice - pos.entryPrice) * pos.quantity;
    } else {
      pnl = (pos.entryPrice - finalExitPrice) * pos.quantity;
    }

    pos.realizedPnl = pnl;
    pos.unrealizedPnl = 0;

    const totalPositionFees = (pos.fees || 0) + finalExitFee;
    pos.fees = totalPositionFees;

    // Refund capital and PnL (minus exit fee) to availableBalance
    const capitalCost = (pos.entryPrice * pos.quantity) / (pos.leverage || 1);
    if (process.env.TRADING_MODE === 'live') {
      try {
        const { fetchBalance } = await import('../services/exchangeService.js');
        const liveBal = await fetchBalance();
        if (liveBal && liveBal.USDT) {
          portfolio.availableBalance = liveBal.USDT.free;
          portfolio.totalBalance = liveBal.USDT.total;
        }
      } catch (bErr) {}
    } else {
      portfolio.availableBalance += (capitalCost + pnl - finalExitFee);
    }
    portfolio.totalPnl += (pnl - totalPositionFees);
    portfolio.dailyLossToday = (portfolio.dailyLossToday || 0) + pnl; // update daily loss with net PnL

    if (pnl >= 0) {
      portfolio.winningTrades += 1;
    } else {
      portfolio.losingTrades += 1;
    }

    const totalClosed = (portfolio.winningTrades || 0) + (portfolio.losingTrades || 0);
    portfolio.winRate = totalClosed > 0 ? portfolio.winningTrades / totalClosed : 0;

    portfolio.markModified('positions');

    // Recalculate total balance using leverage-adjusted universal equity formula
    const marginValue = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();

    // Calculate trade performance percentage (ROE)
    const initialMargin = (pos.entryPrice * pos.quantity) / (pos.leverage || 1);
    const pnlPercent = initialMargin > 0 ? (pnl / initialMargin) * 100 : 0;

    // Close in trade DB
    const trade = await Trade.findOneAndUpdate(
      { asset, status: 'open' },
      {
        status: 'closed',
        exitPrice,
        pnl,
        pnlPercent,
        fees: totalPositionFees,
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

    // Notify Telegram
    await sendTelegramMessage(
      `✅ <b>Position Closed! [Manual]</b>\n` +
      `<b>Asset</b>: ${asset.replace('USDT', '')}/USDT\n` +
      `<b>Side</b>: ${pos.side.toUpperCase()}\n` +
      `<b>Entry Price</b>: $${formatPrice(pos.entryPrice)}\n` +
      `<b>Exit Price</b>: $${formatPrice(exitPrice)}\n` +
      `<b>Quantity</b>: ${pos.quantity.toFixed(5)}\n` +
      `<b>Gross Realized PnL</b>: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
      `<b>Commission Paid</b>: $${totalPositionFees.toFixed(4)}\n` +
      `<b>Net PnL (After Fees)</b>: ${(pnl - totalPositionFees) >= 0 ? '+' : ''}$${(pnl - totalPositionFees).toFixed(2)}\n` +
      `<b>Reason</b>: Manually closed by user`
    );

    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      winRate: portfolio.winRate,
      openPositions: openPositions.length,
      allocation: portfolio.allocationBreakdown,
      winningTrades: portfolio.winningTrades,
      losingTrades: portfolio.losingTrades,
      totalTrades: portfolio.totalTrades,
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
