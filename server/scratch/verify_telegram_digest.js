import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';

// IST boundary for June 2, 2026:
// Starts at 2026-06-01 18:30:00 UTC (June 2, 00:00:00 IST)
// Ends at 2026-06-02 18:30:00 UTC (June 3, 00:00:00 IST)
const dayStartUTC = new Date('2026-06-01T18:30:00.000Z');
const dayEndUTC = new Date('2026-06-02T18:30:00.000Z');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  console.log('=== 🔎 TELEGRAM DIGEST DATABASE VERIFICATION ===\n');

  // Closed trades in this range
  const closedTrades = await Trade.find({
    status: 'closed',
    closedAt: { $gte: dayStartUTC, $lt: dayEndUTC }
  });

  const wins = closedTrades.filter(t => (t.pnl - t.fees) >= 0).length;
  const losses = closedTrades.length - wins;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

  const totalFees = closedTrades.reduce((sum, t) => sum + (t.fees || 0), 0);
  const totalGross = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalNet = totalGross - totalFees;

  console.log('--- Calculated from Database for June 2, 2026 (IST boundaries) ---');
  console.log(`Total Closed Trades: ${closedTrades.length}`);
  console.log(` Winning Trades    : ${wins}`);
  console.log(` Losing Trades     : ${losses}`);
  console.log(` Win Rate          : ${winRate.toFixed(1)}%`);
  console.log(` Gross Profit      : +$${totalGross.toFixed(4)}`);
  console.log(` Commissions Paid  : -$${totalFees.toFixed(4)}`);
  console.log(` Net Daily PnL     : ${totalNet >= 0 ? '+' : ''}$${totalNet.toFixed(4)}`);

  // Fetch current portfolio state
  const portfolio = await Portfolio.findOne({});
  if (portfolio) {
    console.log('\n--- Current Portfolio State in Database ---');
    console.log(` totalBalance      : $${portfolio.totalBalance.toFixed(2)}`);
    console.log(` availableBalance  : $${portfolio.availableBalance.toFixed(2)}`);
  }

  await mongoose.disconnect();
}

run().catch(console.error);
