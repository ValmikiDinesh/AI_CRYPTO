import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({});
  console.log("Current DB Open Positions:");
  const openPositions = portfolio.positions.filter(p => p.status === 'open');
  if (openPositions.length === 0) {
    console.log("No open positions in DB.");
  } else {
    openPositions.forEach(p => {
      console.log(`- Asset: ${p.asset}, Side: ${p.side}, Qty: ${p.quantity}, Entry: ${p.entryPrice}, Unrealized PnL: ${p.unrealizedPnl}`);
    });
  }
  
  console.log("\nIgnored list state:");
  console.log("- manuallyDisabledAssets:", portfolio.manuallyDisabledAssets);
  console.log("- autoIgnoredAssets:", portfolio.autoIgnoredAssets);
  console.log("- isSquaringOff:", portfolio.isSquaringOff);
  console.log("- tradingPaused:", portfolio.tradingPaused);

  await mongoose.connection.close();
}

run().catch(console.error);
