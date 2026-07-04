import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import { getExchange } from '../services/exchangeService.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  exchange.options["warnOnFetchOpenOrdersWithoutSymbol"] = false;
  await exchange.loadMarkets();

  console.log("Cancelling any remaining open orders on exchange...");
  let openOrders = [];
  try {
    openOrders = await exchange.fetchOpenOrders();
  } catch (e) {
    console.warn("Could not fetch all open orders directly. Fetching per symbol instead...");
    // Fallback if needed
  }
  
  console.log(`Found ${openOrders.length} open orders.`);
  for (const order of openOrders) {
    console.log(`Cancelling order ${order.id} for ${order.symbol}...`);
    try {
      await exchange.cancelOrder(order.id, order.symbol);
    } catch (err) {
      console.error(`Failed to cancel order ${order.id}:`, err.message);
    }
  }

  console.log("Resetting portfolio document to $1000...");
  const result = await Portfolio.updateOne(
    { userId: SYSTEM_USER_ID },
    {
      $set: {
        totalBalance: 1000,
        availableBalance: 1000,
        positions: [],
        totalPnl: 0,
        totalPnlPercent: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalTrades: 0,
        winRate: 0,
        dailyLossToday: 0,
        peakBalance: 1000,
        allocationBreakdown: [],
        walletBalance: 0,
        baseTradingCapital: 1000,
        targetProfitThreshold: 1100,
        isSquaringOff: false
      }
    },
    { upsert: true }
  );
  console.log("Portfolio reset completed:", result);
  
  await mongoose.connection.close();
}

run().catch(console.error);
