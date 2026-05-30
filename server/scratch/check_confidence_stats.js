import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  // Find the highest confidence trades in the database
  const highConfTrades = await Trade.find({
    status: { $in: ['open', 'closed'] }
  }).sort({ confidence: -1 }).limit(10);

  console.log('=== HIGHEST CONFIDENCE TRADES IN DATABASE ===');
  for (const t of highConfTrades) {
    console.log(`Asset: ${t.asset} | Action: ${t.action} | Confidence: ${(t.confidence * 100).toFixed(1)}% | Status: ${t.status} | Net: ${t.status === 'closed' ? (t.pnl - t.fees).toFixed(4) : 'N/A'}`);
  }

  // Count distribution of confidence
  const total = await Trade.countDocuments({ status: { $in: ['open', 'closed'] } });
  const above30 = await Trade.countDocuments({ status: { $in: ['open', 'closed'] }, confidence: { $gte: 0.30 } });
  const above40 = await Trade.countDocuments({ status: { $in: ['open', 'closed'] }, confidence: { $gte: 0.40 } });
  const above50 = await Trade.countDocuments({ status: { $in: ['open', 'closed'] }, confidence: { $gte: 0.50 } });
  const above55 = await Trade.countDocuments({ status: { $in: ['open', 'closed'] }, confidence: { $gte: 0.55 } });
  const above60 = await Trade.countDocuments({ status: { $in: ['open', 'closed'] }, confidence: { $gte: 0.60 } });

  console.log('\n=== CONFIDENCE DISTRIBUTION ===');
  console.log(`Total trades in DB: ${total}`);
  console.log(`Confidence >= 30%: ${above30} (${((above30/total)*100).toFixed(1)}%)`);
  console.log(`Confidence >= 40%: ${above40} (${((above40/total)*100).toFixed(1)}%)`);
  console.log(`Confidence >= 50%: ${above50} (${((above50/total)*100).toFixed(1)}%)`);
  console.log(`Confidence >= 55%: ${above55} (${((above55/total)*100).toFixed(1)}%)`);
  console.log(`Confidence >= 60%: ${above60} (${((above60/total)*100).toFixed(1)}%)`);

  await mongoose.disconnect();
}

run().catch(console.error);
