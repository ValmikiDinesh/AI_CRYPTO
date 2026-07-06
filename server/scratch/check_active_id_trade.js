import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  // Find the open/active IDUSDT trade in DB
  const trade = await Trade.findOne({ asset: 'IDUSDT', status: 'open' }).lean();
  
  if (!trade) {
    console.log("No active IDUSDT trade found in DB.");
  } else {
    console.log("=== Active Trade Details ===");
    console.log("- Asset:", trade.asset);
    console.log("- Action:", trade.action);
    console.log("- Side:", trade.side);
    console.log("- Quantity:", trade.quantity);
    console.log("- Entry Price:", trade.entryPrice);
    console.log("- Status:", trade.status);
    console.log("- Opened At:", trade.createdAt ? trade.createdAt.toISOString() : 'N/A');
    console.log("- Metadata:", JSON.stringify(trade.metadata, null, 2));
  }

  await mongoose.connection.close();
}

run().catch(console.error);
