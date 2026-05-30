import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  console.log('=== PORTFOLIO STATE ===');
  if (portfolio) {
    console.log(`totalBalance: ${portfolio.totalBalance}`);
    console.log(`availableBalance: ${portfolio.availableBalance}`);
    console.log(`totalPnl: ${portfolio.totalPnl}`);
    console.log(`dailyLossToday (Daily Net PnL in server): ${portfolio.dailyLossToday}`);
    console.log(`winningTrades: ${portfolio.winningTrades}`);
    console.log(`losingTrades: ${portfolio.losingTrades}`);
    console.log(`lastDailyDigestDate: ${portfolio.lastDailyDigestDate}`);
  } else {
    console.log('No portfolio found!');
  }

  console.log('\n=== CLOSED TRADES TODAY ===');
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  console.log(`Today range (Local): ${startOfToday.toISOString()} to ${startOfTomorrow.toISOString()}`);
  
  const trades = await Trade.find({
    status: 'closed',
    closedAt: { $gte: startOfToday, $lt: startOfTomorrow }
  }).sort({ closedAt: -1 });

  console.log(`Found ${trades.length} trades closed today locally:`);
  let totalPnl = 0;
  let totalFees = 0;
  let totalNet = 0;

  for (const t of trades) {
    const net = t.pnl - t.fees;
    totalPnl += t.pnl;
    totalFees += t.fees;
    totalNet += net;
    console.log(`Asset: ${t.asset} | Open: ${t.createdAt.toISOString()} | Close: ${t.closedAt ? t.closedAt.toISOString() : t.updatedAt.toISOString()} | Gross PnL: $${t.pnl.toFixed(4)} | Fees: $${t.fees.toFixed(4)} | Net: $${net.toFixed(4)} | Reason: ${t.metadata?.closeReason}`);
  }
  
  console.log(`\nTotals (Today Local):`);
  console.log(`Gross PnL sum: $${totalPnl.toFixed(4)}`);
  console.log(`Fees sum: $${totalFees.toFixed(4)}`);
  console.log(`Net Return sum: $${totalNet.toFixed(4)}`);

  await mongoose.disconnect();
}

run().catch(console.error);
