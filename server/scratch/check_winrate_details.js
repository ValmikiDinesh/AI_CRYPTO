import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  console.log('=== 📊 DATABASE TRADE ANALYSIS ===\n');

  const totalTrades = await Trade.countDocuments({ status: { $in: ['open', 'closed'] } });
  console.log(`Total Active/Closed Trades in Database: ${totalTrades}\n`);

  // --- ANALYSIS 1: WIN RATE BY CONFIDENCE BRACKET ---
  const lowConfClosed = await Trade.find({ status: 'closed', confidence: { $lt: 0.40 } });
  const lowConfWins = lowConfClosed.filter(t => (t.pnl - t.fees) >= 0).length;
  const lowConfLosses = lowConfClosed.length - lowConfWins;
  const lowConfWinRate = lowConfClosed.length > 0 ? (lowConfWins / lowConfClosed.length) * 100 : 0;

  console.log('=== 1. Win Rate of Low Confidence (< 40%) Trades ===');
  console.log(`Total Closed: ${lowConfClosed.length}`);
  console.log(`Wins: ${lowConfWins} | Losses: ${lowConfLosses}`);
  console.log(`Win Rate: ${lowConfWinRate.toFixed(2)}%\n`);

  const highConfClosed = await Trade.find({ status: 'closed', confidence: { $gte: 0.40 } });
  const highConfWins = highConfClosed.filter(t => (t.pnl - t.fees) >= 0).length;
  const highConfLosses = highConfClosed.length - highConfWins;
  const highConfWinRate = highConfClosed.length > 0 ? (highConfWins / highConfClosed.length) * 100 : 0;

  console.log('=== 2. Win Rate of High Confidence (>= 40%) Trades ===');
  console.log(`Total Closed: ${highConfClosed.length}`);
  console.log(`Wins: ${highConfWins} | Losses: ${highConfLosses}`);
  console.log(`Win Rate: ${highConfWinRate.toFixed(2)}%\n`);

  // --- ANALYSIS 2: POST-FIX TRADES VERIFICATION ---
  // Fix was deployed on June 2nd, 2026. Let's look at trades created since June 2, 2026 05:30 UTC (11:00 AM IST)
  const fixTime = new Date('2026-06-02T05:30:00Z');
  
  const postFixTrades = await Trade.find({
    createdAt: { $gte: fixTime }
  }).sort({ createdAt: -1 });

  console.log('=== 3. Trades Executed AFTER our Environment Fix ===');
  console.log(`Deployed Fix Time: ${fixTime.toISOString()}`);
  console.log(`Trades Found: ${postFixTrades.length}`);

  if (postFixTrades.length > 0) {
    const postFixLowConf = postFixTrades.filter(t => t.confidence < 0.40);
    const postFixHighConf = postFixTrades.filter(t => t.confidence >= 0.40);
    
    console.log(`└─ High Confidence (>= 40%): ${postFixHighConf.length}`);
    console.log(`└─ Low Confidence (< 40%): ${postFixLowConf.length}`);
    
    if (postFixLowConf.length > 0) {
      console.log('\n⚠️ Alert: Found low confidence trades executed post-fix:');
      postFixLowConf.slice(0, 5).forEach(t => {
        console.log(`   • ${t.asset} | Side: ${t.side} | Conf: ${(t.confidence * 100).toFixed(1)}% | Created: ${t.createdAt.toISOString()}`);
      });
    } else {
      console.log('✨ Success: Zero (0) low-confidence trades have been opened since the threshold fix!');
    }
  } else {
    console.log('ℹ️ No trades have been executed yet since the fix was deployed (market waiting for signals >= 40% confidence).');
  }

  // --- ANALYSIS 3: RECENT TRADES BREAKDOWN ---
  const recentTrades = await Trade.find({ status: { $in: ['open', 'closed'] } })
    .sort({ createdAt: -1 })
    .limit(10);

  console.log('\n=== 4. Ten Most Recent Trades (Latest First) ===');
  recentTrades.forEach(t => {
    const net = t.status === 'closed' ? (t.pnl - t.fees) : null;
    const netStr = net !== null ? `${net >= 0 ? '+' : ''}$${net.toFixed(2)}` : 'OPEN';
    console.log(`• ${t.asset} | Conf: ${(t.confidence * 100).toFixed(1)}% | Status: ${t.status} | Net: ${netStr} | Created: ${t.createdAt.toISOString()}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
