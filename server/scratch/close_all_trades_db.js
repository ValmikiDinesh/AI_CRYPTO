import '../config/env.js';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';
import { publishEvent, CHANNELS } from '../config/redis.js';

async function closeAllTradesAndPositions() {
  await connectDB();

  console.log('=== 🔄 CLOSING ALL OPEN AND PENDING TRADES ===\n');

  try {
    // 1. Close open and pending trades in Trade collection
    const tradesToClose = await Trade.find({
      status: { $in: ['open', 'pending'] }
    });

    console.log(`Found ${tradesToClose.length} open/pending trades to close.`);

    const now = new Date();
    let closedTradesCount = 0;
    for (const trade of tradesToClose) {
      trade.status = 'closed';
      trade.exitPrice = trade.entryPrice; // exit at entry price (0 PnL)
      trade.pnl = 0;
      trade.pnlPercent = 0;
      trade.closedAt = now;
      if (!trade.metadata) trade.metadata = {};
      trade.metadata.closeReason = 'Bulk closed by admin';
      await trade.save();
      closedTradesCount++;
    }
    console.log(`Updated ${closedTradesCount} trades to 'closed' status in Trade collection.`);

    // 2. Update Portfolio documents: close positions and reset available balance
    const portfolios = await Portfolio.find({});
    for (const portfolio of portfolios) {
      let openPositionsCount = 0;
      
      portfolio.positions.forEach(p => {
        if (p.status === 'open') {
          p.status = 'closed';
          p.closedAt = now;
          p.realizedPnl = 0;
          p.unrealizedPnl = 0;
          openPositionsCount++;
        }
      });
      
      console.log(`Portfolio [${portfolio._id}]: Closed ${openPositionsCount} active positions.`);

      // Since all positions are closed, the available balance is now equal to the total balance
      portfolio.availableBalance = portfolio.totalBalance;
      portfolio.allocationBreakdown = [];
      
      await portfolio.save();
      console.log(`Portfolio [${portfolio._id}] saved. Balance reset: Available Balance = Total Balance = $${portfolio.totalBalance.toFixed(2)}`);

      // 3. Publish update to the frontend
      try {
        await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
          totalBalance: portfolio.totalBalance,
          availableBalance: portfolio.availableBalance,
          totalPnl: portfolio.totalPnl,
          totalPnlPercent: portfolio.totalPnlPercent,
          winRate: portfolio.winRate,
          openPositions: 0,
          allocation: [],
          winningTrades: portfolio.winningTrades,
          losingTrades: portfolio.losingTrades,
          totalTrades: portfolio.totalTrades,
        });
        console.log(`📢 Published updates for portfolio [${portfolio._id}] via Redis.`);
      } catch (pubErr) {
        console.warn(`Could not publish update via Redis: ${pubErr.message}`);
      }
    }

    console.log('\n✨ Database update complete! All open/pending trades and positions closed.');
  } catch (err) {
    console.error('Error during database update:', err);
  } finally {
    mongoose.connection.close();
    process.exit(0);
  }
}

closeAllTradesAndPositions();
