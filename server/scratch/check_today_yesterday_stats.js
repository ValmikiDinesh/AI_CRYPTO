import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

// Indian Standard Time offset (UTC + 5.5 hours)
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Current system time
  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET);

  // Today start in IST: 2026-06-02 00:00:00
  const todayStartIST = new Date(
    nowIST.getUTCFullYear(),
    nowIST.getUTCMonth(),
    nowIST.getUTCDate()
  );
  const todayStartUTC = new Date(todayStartIST.getTime() - IST_OFFSET);

  // Yesterday start in IST: 2026-06-01 00:00:00
  const yesterdayStartUTC = new Date(todayStartUTC.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayEndUTC = todayStartUTC;

  console.log('=== 📅 DATE RANGES (IST-Aware) ===');
  console.log(`TODAY (IST)    : ${new Date(todayStartUTC.getTime() + IST_OFFSET).toISOString().replace('Z', '')} +05:30 to Current`);
  console.log(`               : UTC: ${todayStartUTC.toISOString()} to ${now.toISOString()}`);
  console.log(`YESTERDAY (IST): ${new Date(yesterdayStartUTC.getTime() + IST_OFFSET).toISOString().replace('Z', '')} +05:30 to ${new Date(yesterdayEndUTC.getTime() + IST_OFFSET).toISOString().replace('Z', '')} +05:30`);
  console.log(`               : UTC: ${yesterdayStartUTC.toISOString()} to ${yesterdayEndUTC.toISOString()}\n`);

  // --- TODAY'S DATA ---
  const todayTrades = await Trade.find({
    createdAt: { $gte: todayStartUTC }
  });
  
  const todayClosed = todayTrades.filter(t => t.status === 'closed');
  const todayOpen = todayTrades.filter(t => t.status === 'open');
  
  const todayWins = todayClosed.filter(t => (t.pnl - t.fees) >= 0).length;
  const todayLosses = todayClosed.length - todayWins;
  const todayWinRate = todayClosed.length > 0 ? (todayWins / todayClosed.length) * 100 : 0;
  
  let todayGrossProfit = 0;
  let todayGrossLoss = 0;
  let todayFees = 0;
  
  todayClosed.forEach(t => {
    const net = t.pnl - t.fees;
    todayFees += t.fees || 0;
    if (net >= 0) {
      todayGrossProfit += net;
    } else {
      todayGrossLoss += Math.abs(net);
    }
  });
  
  const todayNetReturn = todayGrossProfit - todayGrossLoss;

  console.log('==================================================');
  console.log('📊 REPORT FOR TODAY (JUNE 2, 2026)');
  console.log('==================================================');
  console.log(`Total Trades Opened Today : ${todayTrades.length}`);
  console.log(`├─ Open Positions        : ${todayOpen.length}`);
  console.log(`└─ Closed Positions      : ${todayClosed.length}`);
  console.log(`Wins                     : ${todayWins}`);
  console.log(`Losses                   : ${todayLosses}`);
  console.log(`Win Rate                 : ${todayWinRate.toFixed(2)}%`);
  console.log(`Gross Profit             : +$${todayGrossProfit.toFixed(2)}`);
  console.log(`Gross Loss               : -$${todayGrossLoss.toFixed(2)}`);
  console.log(`Total Fees/Commissions   : $${todayFees.toFixed(2)}`);
  console.log(`Net Realized PnL         : ${todayNetReturn >= 0 ? '+' : ''}$${todayNetReturn.toFixed(2)}`);
  
  console.log('\nConfidence level of trades opened today:');
  const todayAbove40 = todayTrades.filter(t => t.confidence >= 0.40).length;
  const todayBelow40 = todayTrades.filter(t => t.confidence < 0.40).length;
  console.log(`├─ High Confidence (>= 40%): ${todayAbove40}`);
  console.log(`└─ Low Confidence (< 40%) : ${todayBelow40}`);
  
  if (todayTrades.length > 0) {
    console.log('\nDetailed List of Today\'s Trades:');
    todayTrades.forEach((t, i) => {
      const net = t.status === 'closed' ? (t.pnl - t.fees) : null;
      const netStr = net !== null ? `${net >= 0 ? '+' : ''}$${net.toFixed(2)}` : 'OPEN';
      console.log(`   ${i+1}. ${t.asset} | ${t.side.toUpperCase()} | Conf: ${(t.confidence * 100).toFixed(1)}% | Status: ${t.status} | Return: ${netStr} | Created: ${t.createdAt.toISOString()}`);
    });
  }

  // --- YESTERDAY'S DATA ---
  const yesterdayTrades = await Trade.find({
    createdAt: { $gte: yesterdayStartUTC, $lt: yesterdayEndUTC }
  });
  
  const yesterdayClosed = yesterdayTrades.filter(t => t.status === 'closed');
  const yesterdayOpen = yesterdayTrades.filter(t => t.status === 'open');
  
  const yesterdayWins = yesterdayClosed.filter(t => (t.pnl - t.fees) >= 0).length;
  const yesterdayLosses = yesterdayClosed.length - yesterdayWins;
  const yesterdayWinRate = yesterdayClosed.length > 0 ? (yesterdayWins / yesterdayClosed.length) * 100 : 0;
  
  let yesterdayGrossProfit = 0;
  let yesterdayGrossLoss = 0;
  let yesterdayFees = 0;
  
  yesterdayClosed.forEach(t => {
    const net = t.pnl - t.fees;
    yesterdayFees += t.fees || 0;
    if (net >= 0) {
      yesterdayGrossProfit += net;
    } else {
      yesterdayGrossLoss += Math.abs(net);
    }
  });
  
  const yesterdayNetReturn = yesterdayGrossProfit - yesterdayGrossLoss;

  console.log('\n==================================================');
  console.log('📊 REPORT FOR YESTERDAY (JUNE 1, 2026)');
  console.log('==================================================');
  console.log(`Total Trades Opened Yesterday : ${yesterdayTrades.length}`);
  console.log(`├─ Open Positions           : ${yesterdayOpen.length}`);
  console.log(`└─ Closed Positions         : ${yesterdayClosed.length}`);
  console.log(`Wins                        : ${yesterdayWins}`);
  console.log(`Losses                      : ${yesterdayLosses}`);
  console.log(`Win Rate                    : ${yesterdayWinRate.toFixed(2)}%`);
  console.log(`Gross Profit                : +$${yesterdayGrossProfit.toFixed(2)}`);
  console.log(`Gross Loss                  : -$${yesterdayGrossLoss.toFixed(2)}`);
  console.log(`Total Fees/Commissions      : $${yesterdayFees.toFixed(2)}`);
  console.log(`Net Realized PnL            : ${yesterdayNetReturn >= 0 ? '+' : ''}$${yesterdayNetReturn.toFixed(2)}`);
  
  console.log('\nConfidence level of trades opened yesterday:');
  const yesterdayAbove40 = yesterdayTrades.filter(t => t.confidence >= 0.40).length;
  const yesterdayBelow40 = yesterdayTrades.filter(t => t.confidence < 0.40).length;
  console.log(`├─ High Confidence (>= 40%): ${yesterdayAbove40}`);
  console.log(`└─ Low Confidence (< 40%) : ${yesterdayBelow40}`);
  
  if (yesterdayTrades.length > 0) {
    console.log('\nDetailed List of Yesterday\'s Trades (Sample):');
    yesterdayTrades.slice(0, 10).forEach((t, i) => {
      const net = t.status === 'closed' ? (t.pnl - t.fees) : null;
      const netStr = net !== null ? `${net >= 0 ? '+' : ''}$${net.toFixed(2)}` : 'OPEN';
      console.log(`   ${i+1}. ${t.asset} | ${t.side.toUpperCase()} | Conf: ${(t.confidence * 100).toFixed(1)}% | Status: ${t.status} | Return: ${netStr}`);
    });
  }

  await mongoose.disconnect();
}

run().catch(console.error);
