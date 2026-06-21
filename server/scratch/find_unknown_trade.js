import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const trades = await Trade.find({ status: 'closed' }).lean();
  console.log(`Found ${trades.length} closed trades:`);
  
  trades.forEach(t => {
    const source = t.metadata?.sourceModel || 'none';
    let category = 'unknown';
    if (source.includes('ai_')) {
      category = 'ai';
    } else if (source.includes('fallback') || source.includes('statistical')) {
      category = 'fallback';
    }

    const netPnl = (t.pnl || 0) - (t.fees || 0);

    if (category === 'unknown') {
      console.log(`[UNKNOWN CATEGORY]`);
      console.log(`- _id: ${t._id}`);
      console.log(`- asset: ${t.asset}`);
      console.log(`- action: ${t.action}`);
      console.log(`- side: ${t.side}`);
      console.log(`- quantity: ${t.quantity}`);
      console.log(`- entryPrice: ${t.entryPrice}`);
      console.log(`- exitPrice: ${t.exitPrice}`);
      console.log(`- pnl: ${t.pnl}`);
      console.log(`- fees: ${t.fees}`);
      console.log(`- netPnl: ${netPnl}`);
      console.log(`- metadata: ${JSON.stringify(t.metadata)}`);
      console.log(`- closedAt: ${t.closedAt}`);
    }
  });

  await mongoose.connection.close();
}

run().catch(console.error);
