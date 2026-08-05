import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Portfolio from './server/models/Portfolio.js';

async function run() {
  await connectDB();
  const p = await Portfolio.findOne({ userId: 'system' }).lean();
  console.log('totalBalance:', p.totalBalance);
  console.log('positions length:', p.positions.length);
  p.positions.forEach(pos => console.log('pos:', pos.asset, pos.quantity, pos.entryPrice));
  process.exit(0);
}
run();
