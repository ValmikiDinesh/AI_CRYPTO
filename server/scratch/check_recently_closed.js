import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  // Find trades closed in the last 20 minutes
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
  
  const trades = await Trade.find({
    status: 'closed',
    closedAt: { $gte: twentyMinutesAgo }
  }).sort({ closedAt: -1 }).lean();

  console.log(`Found ${trades.length} trades closed in the last 20 minutes:\n`);
  trades.forEach(t => {
    console.log(`- Asset: ${t.asset}`);
    console.log(`  Side: ${t.side.toUpperCase()}`);
    console.log(`  Qty: ${t.quantity}`);
    console.log(`  Entry Price: $${t.entryPrice}`);
    console.log(`  Exit Price: $${t.exitPrice}`);
    console.log(`  Net PnL: $${((t.pnl || 0) - (t.fees || 0)).toFixed(4)}`);
    console.log(`  Closed At: ${t.closedAt.toISOString()}`);
    console.log(`  Close Reason: ${t.metadata?.closeReason || 'N/A'}`);
    console.log(`-----------------------------------`);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
