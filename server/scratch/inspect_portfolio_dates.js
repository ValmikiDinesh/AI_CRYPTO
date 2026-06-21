import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolios = await Portfolio.find({});
  console.log(`Found ${portfolios.length} portfolios:`);
  portfolios.forEach(p => {
    console.log(`- _id: ${p._id}, createdAt: ${p.createdAt}, totalBalance: ${p.totalBalance}, availableBalance: ${p.availableBalance}, tradingPaused: ${p.tradingPaused}, walletBalance: ${p.walletBalance}`);
  });
  await mongoose.connection.close();
}

run().catch(console.error);
