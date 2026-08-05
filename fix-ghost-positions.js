import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Portfolio from './server/models/Portfolio.js';
import Trade from './server/models/Trade.js';

async function run() {
  await connectDB();
  const result = await Portfolio.updateOne(
    { userId: 'system' },
    { $set: { positions: [] } }
  );
  
  await Trade.updateMany({ status: 'open' }, { $set: { status: 'failed', reasoning: 'Ghost position cleanup' } });
  
  console.log('Ghost positions cleared from DB!');
  process.exit(0);
}
run();
