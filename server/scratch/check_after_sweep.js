import mongoose from 'mongoose';
import connectDB from './config/db.js';
import Portfolio from './models/Portfolio.js';
import Trade from './models/Trade.js';
import { SYSTEM_USER_ID } from './config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
  console.log("\n=================== PORTFOLIO AFTER SWEEP ===================");
  console.log(JSON.stringify(portfolio, null, 2));

  console.log("\n=================== TRADES CLOSED BY SWEEP ===================");
  const closedBySweep = await Trade.find({
    status: 'closed',
    closeReason: { $regex: /Sweep/i }
  }).sort({ updatedAt: -1 });

  closedBySweep.forEach(t => {
    console.log(`- ${t.asset} | ${t.action} | PnL: $${t.pnl} | Fees: $${t.fees} | Reason: ${t.closeReason}`);
  });

  console.log("\n=================== ALL RECENT CLOSED TRADES ===================");
  const allClosed = await Trade.find({ status: 'closed' }).sort({ updatedAt: -1 }).limit(15);
  allClosed.forEach(t => {
    console.log(`- ${t.asset} | ${t.action} | PnL: $${t.pnl} | Fees: $${t.fees} | Reason: ${t.closeReason || t.reasoning || '—'} | Closed At: ${t.updatedAt}`);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
