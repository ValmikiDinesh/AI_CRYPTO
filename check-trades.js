import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Trade from './server/models/Trade.js';

async function run() {
  await connectDB();
  const trades = await Trade.find({ status: 'open' }).lean();
  console.log(`Found ${trades.length} open trades`);
  trades.forEach(t => console.log(t.asset, t.status));
  process.exit(0);
}
run();
