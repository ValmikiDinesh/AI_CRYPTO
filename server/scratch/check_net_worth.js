import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({});
  
  console.log("=== Portfolio Balance State ===");
  console.log("- totalBalance (Net Worth):", portfolio.totalBalance);
  console.log("- availableBalance:", portfolio.availableBalance);
  console.log("- walletBalance (Vault):", portfolio.walletBalance);
  console.log("- targetProfitThreshold:", portfolio.targetProfitThreshold);
  console.log("- tradingPaused:", portfolio.tradingPaused);
  console.log("- isSquaringOff:", portfolio.isSquaringOff);

  await mongoose.connection.close();
}

run().catch(console.error);
