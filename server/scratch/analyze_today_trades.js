import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  // Fetch all closed trades for today (July 5th, 2026 UTC/Local)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const trades = await Trade.find({ status: 'closed', closedAt: { $gte: todayStart } }).sort({ closedAt: 1 }).lean();
  
  console.log(`=== Today's Closed Trades Analysis (Count: ${trades.length}) ===\n`);
  
  let totalGrossPnl = 0;
  let totalFees = 0;
  let winners = 0;
  let losers = 0;
  
  const basketCloses = [];
  let currentBasket = [];
  
  trades.forEach(t => {
    const netPnl = (t.pnl || 0) - (t.fees || 0);
    totalGrossPnl += (t.pnl || 0);
    totalFees += (t.fees || 0);
    if (netPnl > 0) winners++;
    else losers++;
    
    // Group trades by close reason or timestamp proximity
    const reason = t.metadata?.closeReason || '';
    if (reason.toLowerCase().includes('basket') || reason.toLowerCase().includes('square-off')) {
      currentBasket.push(t);
    }
  });

  console.log(`- Winning Trades: ${winners}`);
  console.log(`- Losing Trades: ${losers}`);
  console.log(`- Win Rate: ${((winners / trades.length) * 100).toFixed(2)}%`);
  console.log(`- Total Gross profit: $${totalGrossPnl.toFixed(2)}`);
  console.log(`- Total Commissions Paid: $${totalFees.toFixed(2)}`);
  console.log(`- Total Net Realized Profit: $${(totalGrossPnl - totalFees).toFixed(2)}\n`);

  // Analyze the basket target hits
  console.log("=== Basket Exits Breakdown ===");
  // Let's group by closedAt timestamp rounded to the nearest minute
  const groupedExits = {};
  trades.forEach(t => {
    const closedAtMin = new Date(t.closedAt).toISOString().substring(0, 16);
    if (!groupedExits[closedAtMin]) {
      groupedExits[closedAtMin] = [];
    }
    groupedExits[closedAtMin].push(t);
  });

  Object.keys(groupedExits).forEach(time => {
    const group = groupedExits[time];
    const sumNet = group.reduce((sum, t) => sum + (t.pnl || 0) - (t.fees || 0), 0);
    const sumGross = group.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const sumFees = group.reduce((sum, t) => sum + (t.fees || 0), 0);
    console.log(`- Time: ${time} UTC`);
    console.log(`  Assets Closed: ${group.map(t => `${t.asset} (${t.side})`).join(', ')}`);
    console.log(`  Gross PnL: $${sumGross.toFixed(2)}`);
    console.log(`  Fees: $${sumFees.toFixed(2)}`);
    console.log(`  Net Realized PnL: $${sumNet.toFixed(2)}`);
    console.log(`  Reason: ${group[0].metadata?.closeReason || 'N/A'}`);
    console.log(`  -----------------------------------`);
  });

  await mongoose.connection.close();
}

run().catch(console.error);
