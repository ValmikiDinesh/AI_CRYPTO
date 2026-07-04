import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
  if (portfolio) {
    portfolio.tradingPaused = true;
    await portfolio.save();
    console.log("Trading successfully PAUSED in database.");
  }
  await mongoose.connection.close();
}

run().catch(console.error);
