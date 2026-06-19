import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();

  // 1. Update XRPUSDT Trade
  const xrpTrade = await Trade.findOne({ asset: 'XRPUSDT', status: 'closed' }).sort({ closedAt: -1 });
  if (xrpTrade) {
    xrpTrade.exitPrice = 1.1203;
    xrpTrade.pnl = (1.13 - 1.1203) * 1786.9; // 17.33293
    xrpTrade.fees = 1.19269741;
    xrpTrade.pnlPercent = (xrpTrade.pnl / ((1.13 * 1786.9) / 5)) * 100; // ROE assuming 5x leverage
    await xrpTrade.save();
    console.log("✅ Updated XRPUSDT Trade:", xrpTrade.pnl, xrpTrade.fees);
  } else {
    console.log("❌ XRPUSDT Trade not found");
  }

  // 2. Update 1000SHIBUSDT Trade
  const shibTrade = await Trade.findOne({ asset: '1000SHIBUSDT', status: 'closed' }).sort({ closedAt: -1 });
  if (shibTrade) {
    shibTrade.exitPrice = 0.004692;
    shibTrade.pnl = (0.00475 - 0.004692) * 464; // 0.026912
    shibTrade.fees = 0.00131163;
    shibTrade.pnlPercent = (shibTrade.pnl / ((0.00475 * 464) / 5)) * 100;
    await shibTrade.save();
    console.log("✅ Updated 1000SHIBUSDT Trade:", shibTrade.pnl, shibTrade.fees);
  } else {
    console.log("❌ 1000SHIBUSDT Trade not found");
  }

  await mongoose.connection.close();
}

run().catch(console.error);
