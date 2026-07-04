import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const trade = await Trade.findById('6a48b7db3ed65263b1a557fb');
  if (trade) {
    console.log("PEPE Trade Metadata:", JSON.stringify(trade.metadata, null, 2));
  } else {
    console.log("Trade not found");
  }
  await mongoose.connection.close();
}

run().catch(console.error);
