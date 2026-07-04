import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  // Use updateOne to bypass mongoose validation in case of old/corrupted document properties
  const result = await Portfolio.updateOne(
    { userId: SYSTEM_USER_ID },
    { $set: { positions: [], tradingPaused: true } }
  );
  
  console.log("Portfolio updated successfully:", result);
  console.log("Trading successfully PAUSED and positions list cleared.");
  
  await mongoose.connection.close();
}

run().catch(console.error);
