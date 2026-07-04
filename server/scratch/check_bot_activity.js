import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({});
  
  console.log("=== Bot State ===");
  console.log("- tradingPaused:", portfolio.tradingPaused);
  console.log("- isSquaringOff:", portfolio.isSquaringOff);
  console.log("- manuallyDisabledAssets:", portfolio.manuallyDisabledAssets);
  console.log("- autoIgnoredAssets:", portfolio.autoIgnoredAssets);

  // Fetch latest fused signals from DB
  const FusedSignal = mongoose.model('FusedSignal', new mongoose.Schema({}, { strict: false }), 'fusedsignals');
  const latestSignals = await FusedSignal.find({}).sort({ timestamp: -1 }).limit(5).lean();
  
  console.log("\n=== Latest Fused Signals (to check if predictions/AI are active) ===");
  if (latestSignals.length === 0) {
    console.log("No fused signals found in DB.");
  } else {
    latestSignals.forEach(s => {
      console.log(`- Asset: ${s.asset}`);
      console.log(`  Action: ${s.action}`);
      console.log(`  Confidence: ${s.confidence}`);
      console.log(`  Source: ${s.sourceModel || 'N/A'}`);
      console.log(`  Timestamp: ${s.timestamp ? new Date(s.timestamp).toISOString() : 'N/A'}`);
      console.log(`  -----------------------------------`);
    });
  }

  // Check if there are any recent trade attempts (pending or closed) in the last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentTrades = await Trade.find({ createdAt: { $gte: oneHourAgo } }).sort({ createdAt: -1 }).lean();
  console.log(`\n=== Trades Placed in the Last Hour: ${recentTrades.length} ===`);
  recentTrades.forEach(t => {
    console.log(`- Asset: ${t.asset}, Action: ${t.action}, Qty: ${t.quantity}, Status: ${t.status}, Source: ${t.metadata?.sourceModel || 'N/A'}, CreatedAt: ${t.createdAt.toISOString()}`);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
