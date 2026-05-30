import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  console.log('--- ANALYZING TRADES ABOVE 40% CONFIDENCE BY ASSET ---');
  const tradeStats = await Trade.aggregate([
    { $match: { confidence: { $gte: 0.40 } } },
    { $group: {
        _id: '$asset',
        count: { $sum: 1 },
        avgConfidence: { $avg: '$confidence' },
        winRate: {
          $avg: {
            $cond: [ { $gt: ['$pnl', 0] }, 1, 0 ]
          }
        }
    }},
    { $sort: { count: -1 } }
  ]);

  for (const t of tradeStats) {
    console.log(`Asset: ${t._id.padEnd(12)} | Trades >=40% Conf: ${t.count} | Avg Conf: ${(t.avgConfidence * 100).toFixed(1)}% | Win Rate: ${(t.winRate * 100).toFixed(1)}%`);
  }

  console.log('\n--- ANALYZING FUSED SIGNALS IN DB BY ASSET ---');
  const signalStats = await Signal.aggregate([
    { $match: { source: 'fusion', confidence: { $gte: 0.40 } } },
    { $group: {
        _id: '$asset',
        count: { $sum: 1 },
        avgConfidence: { $avg: '$confidence' }
    }},
    { $sort: { count: -1 } }
  ]);

  if (signalStats.length === 0) {
    console.log('No fused signals found in the signals collection (they might have expired due to the 6-hour TTL).');
  } else {
    for (const s of signalStats) {
      console.log(`Asset: ${s._id.padEnd(12)} | Fused Signals >=40%: ${s.count} | Avg Conf: ${(s.avgConfidence * 100).toFixed(1)}%`);
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
