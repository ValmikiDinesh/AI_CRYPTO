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

  console.log(`Portfolio positions count: ${portfolio.positions.length}`);
  
  const targetIndices = [202, 203, 208, 212, 213, 214, 215];
  targetIndices.forEach(idx => {
    const pos = portfolio.positions[idx];
    console.log(`\nIndex ${idx}:`);
    if (pos === undefined) {
      console.log("  undefined");
    } else if (pos === null) {
      console.log("  null");
    } else {
      console.log(JSON.stringify(pos, null, 2));
    }
  });

  await mongoose.connection.close();
}

run().catch(console.error);
