import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  const openTrades = await Trade.find({ status: 'open' }).lean();
  console.log(`Checking ${openTrades.length} currently open trades in DB:\n`);
  
  openTrades.forEach(t => {
    console.log(`- Asset: ${t.asset}`);
    console.log(`  Action: ${t.action}`);
    console.log(`  Qty: ${t.quantity}`);
    console.log(`  Source Model: ${t.metadata?.sourceModel || 'N/A'}`);
    console.log(`  Reasoning: ${t.reasoning || 'N/A'}`);
    console.log(`  Created At: ${t.createdAt.toISOString()}`);
    console.log(`-----------------------------------`);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
