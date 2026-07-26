import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import dotenv from 'dotenv';
dotenv.config();

const SYSTEM_USER_ID = new mongoose.Types.ObjectId('000000000000000000000000');

async function run() {
  await connectDB();
  const db = mongoose.connection.db;
  const rawPortfolio = await db.collection('portfolios').findOne({ userId: SYSTEM_USER_ID });
  
  if (!rawPortfolio) {
    console.log("No portfolio found.");
    await mongoose.connection.close();
    return;
  }

  console.log(`Raw positions count: ${rawPortfolio.positions.length}`);
  
  const targetIndices = [202, 203, 208, 212, 213, 214, 215];
  targetIndices.forEach(idx => {
    const pos = rawPortfolio.positions[idx];
    console.log(`\nRaw Index ${idx}:`);
    console.log(pos);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
