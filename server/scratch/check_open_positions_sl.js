import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

const SYSTEM_USER_ID = '000000000000000000000000';

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
  if (!portfolio) {
    console.log("No portfolio found.");
    await mongoose.connection.close();
    return;
  }

  const openPositions = portfolio.positions.filter(p => p && p.status === 'open');
  console.log(`Found ${openPositions.length} open positions:\n`);

  openPositions.forEach(p => {
    console.log(`Asset: ${p.asset}`);
    console.log(`  Side: ${p.side}`);
    console.log(`  Entry Price: $${p.entryPrice}`);
    console.log(`  Current Price: $${p.currentPrice}`);
    console.log(`  Stop Loss: $${p.stopLoss}`);
    console.log(`  Take Profit: $${p.takeProfit}`);
    console.log(`  Highest Profit Milestone: ${p.highestProfitMilestone || 0}`);
    console.log(`  stopLossOrderId: ${p.stopLossOrderId || 'None'}`);
    console.log('-----------------------------');
  });

  await mongoose.connection.close();
}

run().catch(console.error);
