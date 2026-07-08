import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';
import Prediction from '../models/Prediction.js';
import RiskEvent from '../models/RiskEvent.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Starting DB-only clean and reset...");

  // 1. Connect MongoDB
  await connectDB();

  try {
    // Delete/close trades & reset collection info
    const tradesDel = await Trade.deleteMany({});
    const signalsDel = await Signal.deleteMany({});
    const predictionsDel = await Prediction.deleteMany({});
    const riskDel = await RiskEvent.deleteMany({});
    console.log(`Deleted ${tradesDel.deletedCount} Trades from MongoDB`);
    console.log(`Deleted ${signalsDel.deletedCount} Signals from MongoDB`);
    console.log(`Deleted ${predictionsDel.deletedCount} Predictions from MongoDB`);
    console.log(`Deleted ${riskDel.deletedCount} RiskEvents from MongoDB`);

    // Reset portfolio to clean $100 baseline
    const targetPct = parseFloat(process.env.BASKET_PROFIT_TARGET) || 10;
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (portfolio) {
      portfolio.positions = [];
      portfolio.totalBalance = 100;
      portfolio.availableBalance = 100;
      portfolio.totalPnl = 0;
      portfolio.totalPnlPercent = 0;
      portfolio.winningTrades = 0;
      portfolio.losingTrades = 0;
      portfolio.totalTrades = 0;
      portfolio.winRate = 0;
      portfolio.dailyLossToday = 0;
      portfolio.peakBalance = 100;
      portfolio.allocationBreakdown = [];
      portfolio.walletBalance = 0;
      portfolio.tradingPaused = false;
      portfolio.isSquaringOff = false;
      portfolio.basketProfitTargetPct = targetPct;
      portfolio.sweepTargetProfitPct = targetPct;
      portfolio.baseTradingCapital = 100;
      portfolio.targetProfitThreshold = 100 * (1 + targetPct / 100);
      await portfolio.save();
      console.log(`Reset existing Portfolio to $100 capital and cleared positions. (Target Pct: ${targetPct}%)`);
    } else {
      await Portfolio.create({
        userId: SYSTEM_USER_ID,
        totalBalance: 100,
        availableBalance: 100,
        totalPnl: 0,
        totalPnlPercent: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalTrades: 0,
        winRate: 0,
        dailyLossToday: 0,
        peakBalance: 100,
        positions: [],
        allocationBreakdown: [],
        walletBalance: 0,
        tradingPaused: false,
        isSquaringOff: false,
        basketProfitTargetPct: targetPct,
        sweepTargetProfitPct: targetPct,
        baseTradingCapital: 100,
        targetProfitThreshold: 100 * (1 + targetPct / 100),
      });
      console.log(`Created fresh Portfolio with $100 capital. (Target Pct: ${targetPct}%)`);
    }
  } catch (err) {
    console.error("MongoDB cleanup failed:", err.message);
  }

  console.log("DB-only cleanup completed successfully!");
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
