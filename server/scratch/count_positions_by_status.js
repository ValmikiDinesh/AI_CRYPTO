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

  console.log(`Total positions in raw DB document: ${rawPortfolio.positions.length}`);
  
  let openCount = 0;
  let closedCount = 0;
  let corruptedCount = 0;
  let emptyIndices = [];

  rawPortfolio.positions.forEach((pos, idx) => {
    if (!pos) {
      emptyIndices.push(idx);
      corruptedCount++;
    } else if (pos.status === 'open') {
      openCount++;
    } else if (pos.status === 'closed') {
      closedCount++;
    } else {
      corruptedCount++;
      console.log(`Corrupted position at index ${idx}:`, pos);
    }
  });

  console.log(`\nSummary:`);
  console.log(`- Open positions: ${openCount}`);
  console.log(`- Closed positions: ${closedCount}`);
  console.log(`- Corrupted/Null positions: ${corruptedCount}`);
  if (emptyIndices.length > 0) {
    console.log(`- Empty/null indices:`, emptyIndices);
  }

  await mongoose.connection.close();
}

run().catch(console.error);
