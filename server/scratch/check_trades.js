import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const trades = await Trade.find({
    asset: 'ETHUSDT',
    status: 'closed'
  }).sort({ closedAt: -1 }).limit(10);
  
  console.log('Exact timestamps (with milliseconds):');
  for (const t of trades) {
    const dur = t.closedAt - t.executedAt;
    console.log(`Open: ${t.executedAt.toISOString()} | Close: ${t.closedAt.toISOString()} | Duration: ${dur}ms | Reason: ${t.metadata?.closeReason}`);
  }
  await mongoose.disconnect();
}

run().catch(console.error);
