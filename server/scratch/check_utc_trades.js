import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  console.log(`Portfolio dailyLossToday: ${portfolio?.dailyLossToday}`);

  // Find trades closed since UTC today
  const utcToday = new Date('2026-05-30T00:00:00.000Z');
  const trades = await Trade.find({
    status: 'closed',
    closedAt: { $gte: utcToday }
  }).sort({ closedAt: 1 });

  console.log(`Found ${trades.length} trades closed since 2026-05-30 00:00:00 UTC:`);
  let sumNet = 0;
  for (const t of trades) {
    const net = t.pnl - t.fees;
    sumNet += net;
    console.log(`Closed: ${t.closedAt.toISOString()} | Asset: ${t.asset} | Net Return: ${net}`);
  }
  console.log(`Calculated sum of net return since UTC midnight: ${sumNet}`);

  await mongoose.disconnect();
}

run().catch(console.error);
