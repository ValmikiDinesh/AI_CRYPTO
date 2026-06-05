import mongoose from 'mongoose';
import 'dotenv/config';
import MarketData from '../models/MarketData.js';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to database.');

  // Check ETHUSDT and WIFUSDT MarketData around those times
  // 6:35 AM IST is 1:05 AM UTC
  // 8:05 AM IST is 2:35 AM UTC
  
  const startTime = new Date('2026-06-05T01:00:00Z');
  const endTime = new Date('2026-06-05T03:00:00Z');

  const ethData = await MarketData.find({
    asset: 'ETHUSDT',
    openTime: { $gte: startTime, $lte: endTime }
  }).sort({ openTime: 1 });

  console.log('\n--- ETHUSDT Stored MarketData ---');
  ethData.forEach(d => {
    const timeIST = new Date(d.openTime.getTime() + 5.5 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timeIST} IST] Open: ${d.open} | Close: ${d.close} | High: ${d.high} | Low: ${d.low}`);
  });

  const wifData = await MarketData.find({
    asset: 'WIFUSDT',
    openTime: { $gte: startTime, $lte: endTime }
  }).sort({ openTime: 1 });

  console.log('\n--- WIFUSDT Stored MarketData ---');
  wifData.forEach(d => {
    const timeIST = new Date(d.openTime.getTime() + 5.5 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timeIST} IST] Open: ${d.open} | Close: ${d.close} | High: ${d.high} | Low: ${d.low}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
