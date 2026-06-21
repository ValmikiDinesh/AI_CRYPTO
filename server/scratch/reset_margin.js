import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Resetting all portfolio margin/balances in MongoDB...");
  await connectDB();

  // Wipe out all existing portfolios
  const delResult = await Portfolio.deleteMany({});
  console.log(`Deleted ${delResult.deletedCount} old portfolio records.`);

  // Create a clean default portfolio with $1,000 margin
  const newPortfolio = await Portfolio.create({
    userId: null,
    totalBalance: 1000,
    availableBalance: 1000,
    totalPnl: 0,
    totalPnlPercent: 0,
    dailyPnl: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    positions: [],
    allocationBreakdown: [],
    peakBalance: 1000,
    dailyLossToday: 0,
    walletBalance: 0,
    tradingPaused: false,
    targetProfitThreshold: 1100,
    baseTradingCapital: 1000,
  });

  console.log("Successfully created fresh Portfolio baseline:");
  console.log(`- totalBalance: $${newPortfolio.totalBalance}`);
  console.log(`- availableBalance (Margin): $${newPortfolio.availableBalance}`);
  
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
