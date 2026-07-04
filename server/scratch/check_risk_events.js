import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import RiskEvent from '../models/RiskEvent.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const events = await RiskEvent.find({}).sort({ createdAt: -1 }).limit(10);
  console.log("Recent Risk Events:");
  events.forEach(e => {
    console.log(`[${e.createdAt.toISOString()}] Asset: ${e.asset || 'N/A'}, Type: ${e.type}, Message: ${e.message}`);
  });
  await mongoose.connection.close();
}

run().catch(console.error);
