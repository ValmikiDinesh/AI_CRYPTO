import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';

// Mimics the exact client-side filterByDate logic
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

function filterByDate(createdAt) {
  const tradeTime = new Date(createdAt).getTime();
  
  // Use current local system time (IST offset)
  const nowIST = new Date(Date.now() + IST_OFFSET);
  
  const startOfTodayIST = new Date(
    nowIST.getUTCFullYear(),
    nowIST.getUTCMonth(),
    nowIST.getUTCDate()
  );
  
  const startOfToday = startOfTodayIST.getTime() - IST_OFFSET;
  const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;

  return tradeTime >= startOfToday && tradeTime < startOfTomorrow;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const allTrades = await Trade.find({ status: 'closed' });
  
  // Filter trades using the exact Portfolio.jsx date filtration for closed trades
  const todayClosed = allTrades.filter(t => {
    const filterDate = t.closedAt || t.updatedAt || t.createdAt;
    return filterByDate(filterDate);
  });

  const totalCommission = todayClosed.reduce((sum, t) => sum + (t.fees || 0), 0);
  const totalGross = todayClosed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalNet = totalGross - totalCommission;

  console.log('=== 📊 CLIENT-SIDE "TODAY" CLOSED TRADES DIAGNOSTIC ===');
  console.log(`Total closed trades in "Today" view: ${todayClosed.length}`);
  console.log(`Calculated Commission: -$${totalCommission.toFixed(4)}`);
  console.log(`Calculated Gross Return: $${totalGross.toFixed(2)}`);
  console.log(`Calculated Net Return  : $${totalNet.toFixed(2)}\n`);

  console.log('List of trades included in this calculation:');
  todayClosed.forEach((t, i) => {
    const net = t.pnl - t.fees;
    console.log(`   ${i+1}. ${t.asset} | ${t.side.toUpperCase()} | Conf: ${(t.confidence * 100).toFixed(1)}% | Gross: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(4)} | Fees: -$${t.fees.toFixed(4)} | Net: ${net >= 0 ? '+' : ''}$${net.toFixed(4)} | Closed At: ${t.closedAt ? t.closedAt.toISOString() : t.updatedAt.toISOString()}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
