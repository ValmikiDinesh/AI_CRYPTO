import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolios = await Portfolio.find({});
  console.log(`Found ${portfolios.length} portfolios:`);
  for (const p of portfolios) {
    console.log(`ID: ${p._id} | userId: ${p.userId} | totalBalance: ${p.totalBalance} | dailyLossToday: ${p.dailyLossToday} | updatedAt: ${p.updatedAt.toISOString()}`);
  }

  await mongoose.disconnect();
}

run().catch(console.error);
