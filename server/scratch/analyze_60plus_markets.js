import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';

async function run() {
  console.log('Connecting to database...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected successfully!');

  console.log('\n=============================================================');
  console.log('🔍 HISTORICAL TRADES WITH >= 60% CONFIDENCE');
  console.log('=============================================================');
  
  const trades60 = await Trade.find({ confidence: { $gte: 0.60 } }).sort({ confidence: -1 });
  if (trades60.length === 0) {
    console.log('No trades with >= 60% confidence found in the database.');
  } else {
    for (const t of trades60) {
      const pnlStr = t.status === 'closed' ? `${t.pnl >= 0 ? '+' : ''}${(t.pnl - t.fees).toFixed(4)} USDT (${(t.pnlPercent || 0).toFixed(2)}%)` : 'OPEN';
      console.log(`Asset: ${t.asset.padEnd(12)} | Action: ${t.action.padEnd(4)} | Confidence: ${(t.confidence * 100).toFixed(1)}% | Status: ${t.status.padEnd(6)} | Net PnL: ${pnlStr} | Executed At: ${t.executedAt || t.createdAt}`);
    }
  }

  console.log('\n=============================================================');
  console.log('📊 PERFORMANCE BY ASSET (ALL TRADES WITH >= 50% CONFIDENCE)');
  console.log('=============================================================');
  
  const agg50 = await Trade.aggregate([
    { $match: { confidence: { $gte: 0.50 } } },
    { $group: {
        _id: '$asset',
        totalTrades: { $sum: 1 },
        closedTrades: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
        winningTrades: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$pnl', 0] }] }, 1, 0] } },
        totalPnL: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, { $subtract: ['$pnl', '$fees'] }, 0] } },
        avgConfidence: { $avg: '$confidence' },
        avgPnL: { $avg: { $cond: [{ $eq: ['$status', 'closed'] }, { $subtract: ['$pnl', '$fees'] }, null] } }
    }},
    { $project: {
        asset: '$_id',
        totalTrades: 1,
        closedTrades: 1,
        winningTrades: 1,
        totalPnL: 1,
        avgConfidence: 1,
        avgPnL: 1,
        winRate: {
          $cond: [{ $gt: ['$closedTrades', 0] }, { $multiply: [{ $divide: ['$winningTrades', '$closedTrades'] }, 100] }, 0]
        }
    }},
    { $sort: { totalPnL: -1 } }
  ]);

  if (agg50.length === 0) {
    console.log('No assets found with >= 50% confidence trades.');
  } else {
    for (const a of agg50) {
      console.log(`Asset: ${a._id.padEnd(12)} | Trades: ${a.totalTrades} (Closed: ${a.closedTrades}) | Win Rate: ${a.winRate.toFixed(1)}% | Net Profit: ${a.totalPnL.toFixed(4)} USDT | Avg PnL: ${a.avgPnL ? a.avgPnL.toFixed(4) : 0} USDT | Avg Conf: ${(a.avgConfidence * 100).toFixed(1)}%`);
    }
  }

  console.log('\n=============================================================');
  console.log('📈 GENERAL PERFORMANCE BY ASSET (ALL CLOSED TRADES)');
  console.log('=============================================================');

  const aggAll = await Trade.aggregate([
    { $match: { status: 'closed' } },
    { $group: {
        _id: '$asset',
        totalTrades: { $sum: 1 },
        winningTrades: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
        totalPnL: { $sum: { $subtract: ['$pnl', '$fees'] } },
        avgConfidence: { $avg: '$confidence' },
        avgPnL: { $avg: { $subtract: ['$pnl', '$fees'] } }
    }},
    { $project: {
        asset: '$_id',
        totalTrades: 1,
        winningTrades: 1,
        totalPnL: 1,
        avgConfidence: 1,
        avgPnL: 1,
        winRate: { $multiply: [{ $divide: ['$winningTrades', '$totalTrades'] }, 100] }
    }},
    { $sort: { totalPnL: -1 } }
  ]);

  for (const a of aggAll) {
    console.log(`Asset: ${a._id.padEnd(12)} | Closed Trades: ${a.totalTrades} | Win Rate: ${a.winRate.toFixed(1)}% | Net Profit: ${a.totalPnL.toFixed(4)} USDT | Avg PnL: ${a.avgPnL.toFixed(4)} USDT | Avg Conf: ${(a.avgConfidence * 100).toFixed(1)}%`);
  }

  await mongoose.disconnect();
}

run().catch(console.error);
