import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP);
  const trades = await Trade.find({ createdAt: { $gte: resetDate } }).sort({ createdAt: -1 });
  console.log(`Trades since reset (${trades.length}):`);
  trades.forEach(t => {
    console.log(`- ID: ${t._id}, Status: ${t.status}, Asset: ${t.asset}, Action: ${t.action}, Price: ${t.entryPrice}, CreatedAt: ${t.createdAt.toISOString()}`);
  });
  await mongoose.connection.close();
}

run().catch(console.error);
