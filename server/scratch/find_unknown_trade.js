import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP);
  
  const trades = await Trade.find({
    status: 'closed',
    createdAt: { $gte: resetDate }
  }).lean();

  console.log(`Checking ${trades.length} closed trades since reset...`);
  trades.forEach(t => {
    const source = t.metadata?.sourceModel || 'none';
    let category = 'unknown';
    if (source.includes('ai_')) {
      category = 'ai';
    } else if (source.includes('fallback') || source.includes('statistical')) {
      category = 'fallback';
    }
    
    if (category === 'unknown') {
      console.log("\nFound Unknown Trade:");
      console.log(`- ID: ${t._id}`);
      console.log(`- Asset: ${t.asset}`);
      console.log(`- Action: ${t.action}`);
      console.log(`- Qty: ${t.quantity}`);
      console.log(`- Entry: ${t.entryPrice}`);
      console.log(`- Exit: ${t.exitPrice}`);
      console.log(`- Gross PnL: ${t.pnl}`);
      console.log(`- Fees: ${t.fees}`);
      console.log(`- Net PnL: ${(t.pnl || 0) - (t.fees || 0)}`);
      console.log(`- CreatedAt: ${t.createdAt.toISOString()}`);
      console.log(`- ClosedAt: ${t.closedAt ? t.closedAt.toISOString() : 'N/A'}`);
      console.log(`- Metadata:`, JSON.stringify(t.metadata, null, 2));
    }
  });

  await mongoose.connection.close();
}

run().catch(console.error);
