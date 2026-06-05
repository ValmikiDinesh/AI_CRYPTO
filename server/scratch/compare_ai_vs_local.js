import '../config/env.js'; // Load env variables
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';

async function comparePerformance() {
  await connectDB();

  console.log('📊 Analyzing Trade Performance: AI vs Local...\n');

  try {
    // Aggregate completed/closed trades
    const trades = await Trade.find({ status: 'closed' }).lean();

    if (trades.length === 0) {
      console.log('No closed trades found to analyze.');
      process.exit(0);
    }

    const stats = {
      'AI System': { count: 0, wins: 0, losses: 0, totalPnl: 0 },
      'Local Fallback': { count: 0, wins: 0, losses: 0, totalPnl: 0 },
      'Unknown': { count: 0, wins: 0, losses: 0, totalPnl: 0 }
    };

    trades.forEach(trade => {
      const source = trade.metadata?.sourceModel || 'none';
      let category = 'Unknown';
      
      if (source.includes('ai_')) {
        category = 'AI System';
      } else if (source.includes('fallback') || source.includes('statistical')) {
        category = 'Local Fallback';
      }

      const pnl = trade.pnl || 0;
      stats[category].count++;
      stats[category].totalPnl += pnl;

      if (pnl > 0) {
        stats[category].wins++;
      } else if (pnl < 0) {
        stats[category].losses++;
      }
    });

    for (const [category, data] of Object.entries(stats)) {
      if (data.count === 0) continue;
      const winRate = ((data.wins / data.count) * 100).toFixed(2);
      console.log(`=== ${category} ===`);
      console.log(`Total Trades : ${data.count}`);
      console.log(`Wins         : ${data.wins}`);
      console.log(`Losses       : ${data.losses}`);
      console.log(`Win Rate     : ${winRate}%`);
      console.log(`Total PnL    : $${data.totalPnl.toFixed(4)}`);
      console.log('');
    }

    console.log('NOTE: If a system has 0 trades, it may be because trades were executed before the metadata tagging feature was added.');

  } catch (err) {
    console.error('Error analyzing performance:', err);
  } finally {
    mongoose.connection.close();
    process.exit(0);
  }
}

comparePerformance();
