import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolios = await Portfolio.find({});
  portfolios.forEach(p => {
    console.log(`_id: ${p._id}, userId: ${p.userId}, totalBalance: ${p.totalBalance}, availableBalance: ${p.availableBalance}, tradingPaused: ${p.tradingPaused}, walletBalance: ${p.walletBalance}`);
    console.log(`positions count: ${p.positions.length}`);
    const open = p.positions.filter(pos => pos.status === 'open');
    console.log(`open positions count: ${open.length}`);
    open.forEach(pos => {
      console.log(` - ${pos.asset} (${pos.side}): entry ${pos.entryPrice}, current ${pos.currentPrice}, qty ${pos.quantity}`);
    });
  });
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
