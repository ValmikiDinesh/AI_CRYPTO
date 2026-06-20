import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const trades = await Trade.find({ asset: 'PORTALUSDT', status: { $in: ['open', 'closed'] } }).sort({ createdAt: -1 });
  console.log("=== PORTAL OPEN/CLOSED TRADES ===");
  console.log(JSON.stringify(trades, null, 2));
  await mongoose.connection.close();
}

run().catch(console.error);
