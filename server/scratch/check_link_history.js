import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP);
  
  const trades = await Trade.find({
    createdAt: { $gte: resetDate }
  }).sort({ createdAt: -1 }).lean();

  console.log("Recent Trades (Last 10):");
  trades.slice(0, 10).forEach(t => {
    console.log(`- Asset: ${t.asset}, Status: ${t.status}, Action: ${t.action}, Qty: ${t.quantity}, Entry: ${t.entryPrice}, Exit: ${t.exitPrice}, PnL: ${t.pnl}, CreatedAt: ${t.createdAt.toISOString()}, ClosedAt: ${t.closedAt ? t.closedAt.toISOString() : 'N/A'}`);
  });

  const portfolio = await Portfolio.findOne({});
  console.log("\nPortfolio isSquaringOff status:", portfolio.isSquaringOff);
  console.log("Portfolio tradingPaused status:", portfolio.tradingPaused);

  await mongoose.connection.close();
}

run().catch(console.error);
