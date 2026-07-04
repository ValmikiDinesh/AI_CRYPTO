import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const trades = await Trade.find({ asset: { $regex: 'PEPE', $options: 'i' } }).sort({ createdAt: -1 }).limit(5);
  console.log("Recent PEPE Trades:");
  trades.forEach(t => {
    console.log(`- ID: ${t._id}, Status: ${t.status}, Action: ${t.action}, Qty: ${t.quantity}, Price: ${t.entryPrice}, CreatedAt: ${t.createdAt}`);
  });
  await mongoose.connection.close();
}

run().catch(console.error);
