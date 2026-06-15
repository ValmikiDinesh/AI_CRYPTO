import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  const portfolio = await Portfolio.findOne({});
  if (!portfolio) {
    console.log("❌ No portfolio found!");
  } else {
    console.log("=== PORTFOLIO ===");
    console.log(JSON.stringify(portfolio, null, 2));
  }

  const trades = await Trade.find({ asset: 'LABUSDT' });
  console.log("\n=== LABUSDT TRADES ===");
  console.log(JSON.stringify(trades, null, 2));

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
