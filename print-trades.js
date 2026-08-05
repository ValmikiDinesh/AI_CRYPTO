import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Trade from './server/models/Trade.js';

async function run() {
  await connectDB();
  const trades = await Trade.find({}).sort({ createdAt: -1 }).limit(10).lean();
  trades.forEach(t => console.log(t.asset, t.status, t.entryPrice, t.exitPrice, t.pnl, t.reasoning));
  process.exit(0);
}
run();
