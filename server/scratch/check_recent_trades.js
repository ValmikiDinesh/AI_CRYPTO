import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000);
  const trades = await Trade.find({ status: 'closed', closedAt: { $gte: halfHourAgo } }).sort({ closedAt: -1 }).lean();
  
  console.log(`Found ${trades.length} closed trades in the last 30 minutes:\n`);
  
  trades.forEach(t => {
    console.log(`- Asset: ${t.asset}`);
    console.log(`  Action: ${t.action}`);
    console.log(`  Qty: ${t.quantity}`);
    console.log(`  Entry: $${t.entryPrice}, Exit: $${t.exitPrice}`);
    console.log(`  Net PnL: $${(t.pnl || 0) - (t.fees || 0)}`);
    console.log(`  Reason: ${t.metadata?.closeReason || 'N/A'}`);
    console.log(`  ClosedAt: ${t.closedAt.toISOString()}`);
    console.log(`-----------------------------------`);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
