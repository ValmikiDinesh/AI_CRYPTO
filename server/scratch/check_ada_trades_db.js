import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  // Find all closed ADAUSDT trades since today (July 4th/5th 2026)
  const trades = await Trade.find({ asset: 'ADAUSDT', status: 'closed' }).sort({ closedAt: -1 }).lean();
  
  console.log(`Found ${trades.length} closed ADAUSDT trades in DB:\n`);
  
  let totalPnl = 0;
  let totalFees = 0;

  trades.forEach((t, i) => {
    console.log(`Trade #${i + 1}:`);
    console.log(`- Qty: ${t.quantity}`);
    console.log(`- Action: ${t.action}`);
    console.log(`- Entry: $${t.entryPrice}, Exit: $${t.exitPrice}`);
    console.log(`- Gross PnL: $${t.pnl}`);
    console.log(`- Fees: $${t.fees || 0}`);
    const net = (t.pnl || 0) - (t.fees || 0);
    console.log(`- Net PnL: $${net}`);
    console.log(`- Closed At: ${t.closedAt ? t.closedAt.toISOString() : 'N/A'}`);
    console.log(`- Reason: ${t.metadata?.closeReason || 'N/A'}`);
    console.log(`-----------------------------------`);
    
    totalPnl += (t.pnl || 0);
    totalFees += (t.fees || 0);
  });

  console.log(`=== Aggregated Stats ===`);
  console.log(`Total Gross P&L: $${totalPnl}`);
  console.log(`Total Fees: $${totalFees}`);
  console.log(`Total Net Profit: $${totalPnl - totalFees}`);

  await mongoose.connection.close();
}

run().catch(console.error);
