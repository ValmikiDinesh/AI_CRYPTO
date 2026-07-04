import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({});
  console.log("Current DB Positions in Portfolio:");
  portfolio.positions.forEach(p => {
    console.log(`- Asset: ${p.asset}, Side: ${p.side}, Status: ${p.status}, Qty: ${p.quantity}, Entry: ${p.entryPrice}, Current: ${p.currentPrice}, UnrealizedPnL: ${p.unrealizedPnl}`);
  });
  await mongoose.connection.close();
}

run().catch(console.error);
