import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Trade from './server/models/Trade.js';
import Portfolio from './server/models/Portfolio.js';

async function run() {
  await connectDB();
  const trades = await Trade.find({ asset: { $in: ["BEATUSDT", "IDUSDT"] } }).sort({ createdAt: -1 }).limit(5);
  console.log('Trades:', trades.map(t => ({ id: t.orderId, asset: t.asset, status: t.status, reasoning: t.reasoning })));
  
  const port = await Portfolio.findOne({ userId: 'system' });
  console.log('Portfolio Positions:', port ? port.positions.map(p => p.asset) : 'Not found');
  process.exit(0);
}
run();
