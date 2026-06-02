import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

const IST_OFFSET = 5.5 * 60 * 60 * 1000;

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET);

  const todayStartIST = new Date(
    nowIST.getUTCFullYear(),
    nowIST.getUTCMonth(),
    nowIST.getUTCDate()
  );
  const todayStartUTC = new Date(todayStartIST.getTime() - IST_OFFSET);

  // Fetch closed trades matching today
  const closedTrades = await Trade.find({
    status: 'closed',
    closedAt: { $gte: todayStartUTC }
  });

  const openTrades = await Trade.find({
    status: 'open',
    createdAt: { $gte: todayStartUTC }
  });

  const wins = closedTrades.filter(t => (t.pnl - t.fees) >= 0).length;
  const losses = closedTrades.length - wins;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

  const totalFees = closedTrades.reduce((sum, t) => sum + (t.fees || 0), 0);
  const totalGross = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalNet = totalGross - totalFees;

  console.log('=== 📊 UP-TO-DATE TODAY REPORT ===');
  console.log(`Time of check (IST): ${nowIST.toLocaleString()} (+05:30)`);
  console.log(`Total Trades Opened Today       : ${closedTrades.length + openTrades.length}`);
  console.log(`├─ Closed Trades (Finished)    : ${closedTrades.length}`);
  console.log(`└─ Open Positions (Running)     : ${openTrades.length}\n`);

  console.log(`=== Closed Trades Breakdown ===`);
  console.log(`Wins                            : ${wins}`);
  console.log(`Losses                          : ${losses}`);
  console.log(`Win Rate                        : ${winRate.toFixed(2)}%`);
  console.log(`Gross Return                    : ${totalGross >= 0 ? '+' : ''}$${totalGross.toFixed(4)}`);
  console.log(`Commissions Paid                : -$${totalFees.toFixed(4)}`);
  console.log(`Net Return (After Fees)         : ${totalNet >= 0 ? '+' : ''}$${totalNet.toFixed(4)}`);

  await mongoose.disconnect();
}

run().catch(console.error);
