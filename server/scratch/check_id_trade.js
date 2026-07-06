import connectDB from '../config/db.js';
import Trade from '../models/Trade.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  // Find the closed IDUSDT trade around 7:06:10 AM on July 6th, 2026
  const trade = await Trade.findOne({ asset: 'IDUSDT', status: 'closed' }).sort({ closedAt: -1 }).lean();
  
  if (!trade) {
    console.log("No closed IDUSDT trade found.");
  } else {
    console.log("=== Trade Details ===");
    console.log("- Asset:", trade.asset);
    console.log("- Action:", trade.action);
    console.log("- Side:", trade.side);
    console.log("- Quantity:", trade.quantity);
    console.log("- Entry Price:", trade.entryPrice);
    console.log("- Exit Price:", trade.exitPrice);
    console.log("- Gross PnL:", trade.pnl);
    console.log("- Fees:", trade.fees);
    console.log("- Net PnL:", (trade.pnl || 0) - (trade.fees || 0));
    console.log("- Stop Loss:", trade.stopLoss);
    console.log("- Take Profit:", trade.takeProfit);
    console.log("- Opened At:", trade.createdAt ? trade.createdAt.toISOString() : 'N/A');
    console.log("- Closed At:", trade.closedAt ? trade.closedAt.toISOString() : 'N/A');
    console.log("- Metadata:", JSON.stringify(trade.metadata, null, 2));
  }

  await mongoose.connection.close();
}

run().catch(console.error);
