import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { getExchange } from '../services/exchangeService.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Starting clean emergency square-off (preserving history)...");
  await connectDB();

  let exchange;
  try {
    exchange = getExchange();
    await exchange.loadMarkets();
    console.log("Connected to Exchange.");
  } catch (err) {
    console.error("Failed to connect to Exchange:", err.message);
    process.exit(1);
  }

  // 1. Cancel all open orders on exchange
  try {
    console.log("Fetching open orders from exchange...");
    const openOrders = await exchange.fetchOpenOrders();
    console.log(`Found ${openOrders.length} open orders.`);
    for (const order of openOrders) {
      console.log(`Cancelling order ${order.id} for ${order.symbol}`);
      try {
        await exchange.cancelOrder(order.id, order.symbol);
      } catch (e) {
        console.error(`Failed to cancel order ${order.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error("Failed to cancel open orders on exchange:", err.message);
  }

  // 2. Fetch and close all active positions on exchange
  try {
    console.log("Fetching active positions from exchange...");
    const positions = await exchange.fetchPositions();
    const activePositions = positions.filter((p) => parseFloat(p.contracts) > 0);
    console.log(`Found ${activePositions.length} active positions.`);

    for (const pos of activePositions) {
      const symbol = pos.symbol;
      const contracts = parseFloat(pos.contracts);
      const side = pos.side; // 'long' or 'short'
      const exitSide = side === 'long' ? 'sell' : 'buy';

      console.log(`Closing position for ${symbol}: ${side} of size ${contracts}`);
      try {
        const order = await exchange.createMarketOrder(symbol, exitSide, contracts);
        console.log(`Closed position for ${symbol}. Order ID: ${order.id}`);
      } catch (err) {
        console.error(`Failed to close position for ${symbol}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("Failed to close active positions on exchange:", err.message);
  }

  // 3. Update database records
  try {
    console.log("Updating database records...");
    
    // Update all pending trades to cancelled
    const pendingUpdate = await Trade.updateMany(
      { status: 'pending' },
      { status: 'cancelled', metadata: { cancelReason: 'Emergency Manual Square-Off' } }
    );
    console.log(`Updated ${pendingUpdate.modifiedCount} pending trades to cancelled.`);

    // Update all open trades to closed
    const openTrades = await Trade.find({ status: 'open' });
    console.log(`Found ${openTrades.length} open trades in database.`);
    
    for (const trade of openTrades) {
      trade.status = 'closed';
      trade.closedAt = new Date();
      trade.pnl = 0; // Set PnL to 0 or check if we can estimate it
      trade.metadata = { ...(trade.metadata || {}), closeReason: 'Emergency Manual Square-Off' };
      await trade.save();
    }
    console.log(`Updated all open trades in database to closed.`);

    // Reset portfolio balances and empty positions list
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (portfolio) {
      portfolio.positions = [];
      portfolio.availableBalance = portfolio.totalBalance; // Recoil all margin
      await portfolio.save();
      console.log(`Portfolio positions list cleared in DB. Available Balance reset to match Total Balance: $${portfolio.totalBalance.toFixed(2)}`);
    }
  } catch (dbErr) {
    console.error("Database update failed:", dbErr.message);
  }

  console.log("Emergency square-off complete!");
  await mongoose.connection.close();
}

run().catch(console.error);
