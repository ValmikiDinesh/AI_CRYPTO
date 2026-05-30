import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (portfolio) {
    console.log('=== BEFORE RESET ===');
    console.log(`totalBalance: ${portfolio.totalBalance}`);
    console.log(`peakBalance: ${portfolio.peakBalance}`);
    console.log(`drawdown: ${(portfolio.currentDrawdown * 100).toFixed(2)}%`);

    // Reset peakBalance to a realistic value
    portfolio.peakBalance = Math.max(1000, portfolio.totalBalance);
    await portfolio.save();

    console.log('\n=== AFTER RESET ===');
    console.log(`totalBalance: ${portfolio.totalBalance}`);
    console.log(`peakBalance: ${portfolio.peakBalance}`);
    console.log(`drawdown: ${(portfolio.currentDrawdown * 100).toFixed(2)}%`);
  } else {
    console.log('No portfolio found');
  }

  await mongoose.disconnect();
}

run().catch(console.error);
