import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (!portfolio) {
    console.log("❌ No portfolio found in MongoDB!");
  } else {
    console.log("=== CURRENT DATABASE PORTFOLIO ===");
    console.log(`Total Balance: $${portfolio.totalBalance}`);
    console.log(`Available Balance: $${portfolio.availableBalance}`);
    console.log(`Daily Loss Today: $${portfolio.dailyLossToday}`);
    console.log(`Total Trades: ${portfolio.totalTrades}`);
    console.log(`Open Positions count: ${portfolio.positions.filter(p => p.status === 'open').length}`);
    for (const pos of portfolio.positions.filter(p => p.status === 'open')) {
      console.log(`  - Active Position: ${pos.asset} | ${pos.side.toUpperCase()} | Qty: ${pos.quantity} | Entry: $${pos.entryPrice}`);
    }
  }

  const openTrades = await Trade.find({ status: 'open' });
  console.log(`\nOpen Trades in DB: ${openTrades.length}`);
  for (const t of openTrades) {
    console.log(`  - ${t.asset} | ${t.action} | Qty: ${t.quantity} | Entry: $${t.entryPrice}`);
  }

  const pendingTrades = await Trade.find({ status: 'pending' });
  console.log(`Pending Trades in DB: ${pendingTrades.length}`);

  const closedTrades = await Trade.find({ status: 'closed' }).sort({ closedAt: -1 }).limit(5);
  console.log(`Recent Closed Trades in DB (Max 5): ${closedTrades.length}`);
  for (const t of closedTrades) {
    console.log(`  - ${t.asset} | ${t.action} | PnL: $${t.pnl} | Reason: ${t.metadata?.closeReason || 'unknown'}`);
  }

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
