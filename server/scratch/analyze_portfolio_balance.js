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
    console.log("❌ No portfolio found!");
    await mongoose.connection.close();
    return;
  }

  console.log("=== PORTFOLIO METRICS ===");
  console.log(`totalBalance (Net Worth): $${portfolio.totalBalance}`);
  console.log(`availableBalance (Margin): $${portfolio.availableBalance}`);
  console.log(`totalPnl: $${portfolio.totalPnl}`);
  console.log(`totalPnlPercent: ${portfolio.totalPnlPercent}%`);
  console.log(`winningTrades: ${portfolio.winningTrades}`);
  console.log(`losingTrades: ${portfolio.losingTrades}`);
  console.log(`totalTrades: ${portfolio.totalTrades}`);

  const openPositions = portfolio.positions.filter(p => p.status === 'open');
  console.log(`\n=== OPEN POSITIONS (${openPositions.length}) ===`);
  openPositions.forEach(p => {
    console.log(`  - ${p.asset} | Side: ${p.side.toUpperCase()} | Qty: ${p.quantity} | Entry: $${p.entryPrice} | Mark: $${p.currentPrice} | Unrealized PnL: $${p.unrealizedPnl} | Leverage: ${p.leverage}x`);
  });

  const pendingTrades = await Trade.find({ status: 'pending' });
  console.log(`\n=== PENDING TRADES (${pendingTrades.length}) ===`);
  pendingTrades.forEach(t => {
    const margin = (t.entryPrice * t.quantity) / (t.leverage || 3);
    console.log(`  - ${t.asset} | ${t.action} | Qty: ${t.quantity} | Price: $${t.entryPrice} | Margin Reserved: $${margin.toFixed(2)} | Leverage: ${t.leverage}x`);
  });

  const closedTrades = await Trade.find({ status: 'closed' });
  console.log(`\n=== CLOSED TRADES SUMMARY (${closedTrades.length}) ===`);
  let grossPnL = 0;
  let fees = 0;
  closedTrades.forEach(t => {
    grossPnL += (t.pnl || 0);
    fees += (t.fees || 0);
  });
  console.log(`  - Gross PnL: $${grossPnL.toFixed(2)}`);
  console.log(`  - Total Fees: $${fees.toFixed(2)}`);
  console.log(`  - Net PnL (Gross - Fees): $${(grossPnL - fees).toFixed(2)}`);

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
