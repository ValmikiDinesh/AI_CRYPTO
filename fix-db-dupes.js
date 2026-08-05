import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Portfolio from './server/models/Portfolio.js';

async function run() {
  await connectDB();
  const all = await Portfolio.find({});
  console.log(`Total Portfolios: ${all.length}`);
  
  let withKeys = all.filter(p => p.coinSwitchApiKey && p.coinSwitchApiKey.length > 5);
  console.log(`Portfolios with keys: ${withKeys.length}`);
  if (withKeys.length > 0) {
    console.log('Key Portfolio:', withKeys[0]._id, withKeys[0].userId, withKeys[0].activeStrategy);
  }

  process.exit(0);
}
run();
