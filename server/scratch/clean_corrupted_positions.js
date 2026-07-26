import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

const SYSTEM_USER_ID = '000000000000000000000000';

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
  if (!portfolio) {
    console.log("No portfolio found.");
    await mongoose.connection.close();
    return;
  }

  console.log(`Portfolio positions count BEFORE cleaning: ${portfolio.positions.length}`);

  const originalLength = portfolio.positions.length;
  
  // Filter out any positions that are null, undefined, or missing required fields
  const validPositions = portfolio.positions.filter((pos, idx) => {
    if (!pos) {
      console.log(`Removing null/undefined position at index ${idx}`);
      return false;
    }
    
    const hasAsset = typeof pos.asset === 'string' && pos.asset.trim().length > 0;
    const hasSide = ['long', 'short'].includes(pos.side);
    const hasEntryPrice = typeof pos.entryPrice === 'number' && !isNaN(pos.entryPrice);
    const hasQuantity = typeof pos.quantity === 'number' && !isNaN(pos.quantity);

    if (!hasAsset || !hasSide || !hasEntryPrice || !hasQuantity) {
      console.log(`Removing corrupted position at index ${idx}:`, JSON.stringify(pos));
      return false;
    }
    return true;
  });

  portfolio.positions = validPositions;
  console.log(`Portfolio positions count AFTER cleaning: ${portfolio.positions.length}`);

  try {
    await portfolio.save();
    console.log("Successfully saved cleaned portfolio to MongoDB!");
  } catch (err) {
    console.error("Failed to save portfolio after cleaning:", err);
  }

  await mongoose.connection.close();
}

run().catch(console.error);
