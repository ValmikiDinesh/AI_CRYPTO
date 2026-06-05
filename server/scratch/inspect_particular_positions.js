import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to database.');

  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (portfolio) {
    const assetsToCheck = ['1000PEPEUSDT', '1000BONKUSDT', 'STGUSDT'];
    console.log('\n=== Database Positions for check ===');
    portfolio.positions.forEach((p, i) => {
      if (assetsToCheck.includes(p.asset)) {
        console.log(`[Pos #${i}] Asset: ${p.asset} | Status: ${p.status} | Entry: ${p.entryPrice} | Qty: ${p.quantity} | SL: ${p.stopLoss} | TP: ${p.takeProfit} | OpenedAt: ${p.openedAt}`);
      }
    });

    console.log('\n=== Database Trades for check ===');
    const trades = await Trade.find({ asset: { $in: assetsToCheck } }).sort({ createdAt: -1 }).limit(10);
    trades.forEach(t => {
      console.log(`ID: ${t._id} | Asset: ${t.asset} | Status: ${t.status} | Entry: ${t.entryPrice} | Exit: ${t.exitPrice} | SL: ${t.stopLoss} | TP: ${t.takeProfit} | CreatedAt: ${t.createdAt}`);
    });
  }

  await mongoose.disconnect();
}

run().catch(console.error);
