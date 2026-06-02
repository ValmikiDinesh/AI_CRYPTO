import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const totalClosed = await Trade.countDocuments({ status: 'closed' });
  const totalOpen = await Trade.countDocuments({ status: 'open' });
  const totalFailed = await Trade.countDocuments({ status: 'failed' });

  console.log('=== 🔎 TOTAL DATABASE COUNTS ===');
  console.log(`Total Closed: ${totalClosed}`);
  console.log(`Total Open  : ${totalOpen}`);
  console.log(`Total Failed: ${totalFailed}`);

  // Fetch the 5 earliest closed trades to check their timestamps
  const earliest = await Trade.find({ status: 'closed' }).sort({ createdAt: 1 }).limit(5);
  console.log('\n=== EARLIEST CLOSED TRADES ===');
  earliest.forEach((t, i) => {
    console.log(`${i+1}. ${t.asset} | Created: ${t.createdAt.toISOString()} | Closed: ${t.closedAt?.toISOString()}`);
  });

  // Fetch the 5 latest closed trades
  const latest = await Trade.find({ status: 'closed' }).sort({ createdAt: -1 }).limit(5);
  console.log('\n=== LATEST CLOSED TRADES ===');
  latest.forEach((t, i) => {
    console.log(`${i+1}. ${t.asset} | Created: ${t.createdAt.toISOString()} | Closed: ${t.closedAt?.toISOString()}`);
  });

  // Count by date in UTC
  const stats = await Trade.aggregate([
    { $match: { status: 'closed' } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$closedAt" } },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: -1 } }
  ]);

  console.log('\n=== CLOSED TRADES GROUPED BY UTC DATE ===');
  stats.forEach(s => {
    console.log(`Date: ${s._id} | Closed Count: ${s.count}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
