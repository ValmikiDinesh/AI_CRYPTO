import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';
import Prediction from '../models/Prediction.js';
import RiskEvent from '../models/RiskEvent.js';
import dotenv from 'dotenv';
dotenv.config();

const SYSTEM_USER_ID = '000000000000000000000000';

async function run() {
  console.log("Connecting to MongoDB for deduplication and full purge...");
  await connectDB();

  // 1. Delete all old documents
  await Trade.deleteMany({});
  await Signal.deleteMany({});
  await Prediction.deleteMany({});
  await RiskEvent.deleteMany({});
  await Portfolio.deleteMany({});
  console.log("Purged all Trades, Signals, Predictions, RiskEvents, and Portfolios.");

  // 2. Create exactly one clean portfolio document with the constant system ID
  await Portfolio.create({
    userId: SYSTEM_USER_ID,
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
    allocationBreakdown: [],
    walletBalance: 0,
    tradingPaused: false,
    targetProfitThreshold: 1100,
    baseTradingCapital: 1000
  });

  console.log(`Created exactly ONE clean portfolio with system user ID: ${SYSTEM_USER_ID}`);
  await mongoose.connection.close();
}

run().catch(console.error);
