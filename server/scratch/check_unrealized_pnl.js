import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (!portfolio) {
    console.log("❌ No portfolio found.");
  } else {
    console.log("=== UNREALIZED PNL BY POSITION ===");
    let totalUnrealized = 0;
    const openPositions = portfolio.positions.filter(p => p.status === 'open');
    openPositions.forEach(p => {
      console.log(`Asset: ${p.asset} | Side: ${p.side} | Qty: ${p.quantity} | Entry: $${p.entryPrice} | Mark/Current: $${p.currentPrice} | Unrealized PnL: $${p.unrealizedPnl.toFixed(4)}`);
      totalUnrealized += p.unrealizedPnl;
    });
    console.log(`===================================`);
    console.log(`Total Unrealized PnL: $${totalUnrealized.toFixed(4)}`);
  }
  await mongoose.connection.close();
}

run().catch(console.error);
