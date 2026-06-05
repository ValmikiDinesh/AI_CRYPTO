import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to database.');

  const assetsToCheck = ['BOMEUSDT', 'EPICUSDT'];
  const trades = await Trade.find({
    asset: { $in: assetsToCheck },
    status: 'open'
  }).sort({ createdAt: -1 });

  console.log(`\n=== Mismatched Open Trades (${trades.length}) ===`);
  trades.forEach(t => {
    console.log('--------------------------------------------------');
    console.log(`ID: ${t._id}`);
    console.log(`Asset: ${t.asset} | Action: ${t.action} | Side: ${t.side}`);
    console.log(`Entry Price: ${t.entryPrice} | Qty: ${t.quantity}`);
    console.log(`Exchange Order ID: ${t.exchangeOrderId}`);
    console.log(`Status: ${t.status}`);
    console.log(`Reasoning: ${t.reasoning}`);
    console.log(`Metadata: ${JSON.stringify(t.metadata, null, 2)}`);
    console.log(`Created At: ${t.createdAt}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
