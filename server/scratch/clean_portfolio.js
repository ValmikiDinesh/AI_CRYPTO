import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';
import Prediction from '../models/Prediction.js';
import RiskEvent from '../models/RiskEvent.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Connecting to MongoDB for database purge...");
  await connectDB();

  // Purge all collections
  console.log("Purging all trading state collections...");
  await Trade.deleteMany({});
  await Signal.deleteMany({});
  await Prediction.deleteMany({});
  await RiskEvent.deleteMany({});
  await Portfolio.deleteMany({});
  console.log("purged Trades, Signals, Predictions, RiskEvents, and Portfolios.");

  // Recreate clean $1,000 portfolio
  console.log("Recreating clean Portfolio document with $1,000...");
  await Portfolio.create({
    userId: null,
    totalBalance: 1000,
    availableBalance: 1000,
    totalPnl: 0,
    totalPnlPercent: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalTrades: 0,
    winRate: 0,
    dailyLossToday: 0,
    peakBalance: 1000,
    positions: [],
    allocationBreakdown: []
  });

  console.log("Clean portfolio recreation complete!");
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("Purge failed: ", err);
  await mongoose.connection.close();
});
