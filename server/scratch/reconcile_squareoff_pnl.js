import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { getExchange } from '../services/exchangeService.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Starting PnL reconciliation for emergency squared-off trades...");
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

  // Find the trades we closed during emergency square-off today
  const trades = await Trade.find({
    status: 'closed',
    'metadata.closeReason': 'Emergency Manual Square-Off'
  });

  console.log(`Found ${trades.length} trades requiring PnL calculation.`);

  let totalPnL = 0;

  for (const trade of trades) {
    console.log(`\nReconciling ${trade.asset} (${trade.side}):`);
    try {
      // Fetch latest closed orders on exchange for this asset
      const closedOrders = await exchange.fetchClosedOrders(trade.asset, undefined, 10);
      
      // Find the market order placed around our square-off time (within the last 20 minutes)
      // Since it was a market exit order, side is opposite of trade.side ('long' -> 'sell', 'short' -> 'buy')
      const targetSide = trade.side === 'long' ? 'sell' : 'buy';
      
      // Sort closed orders by timestamp descending and find the latest one that matches targetSide
      const exitOrder = closedOrders
        .filter(o => o.side === targetSide && o.type === 'market')
        .sort((a, b) => b.timestamp - a.timestamp)[0];

      if (!exitOrder) {
        console.warn(`Could not find matching exit market order on exchange for ${trade.asset}. Skipping.`);
        continue;
      }

      const exitPrice = exitOrder.average || exitOrder.price;
      if (!exitPrice) {
        console.warn(`Exit order found for ${trade.asset} but has no average/price. Skipping.`);
        continue;
      }

      // Calculate PnL
      const entryPrice = trade.entryPrice;
      const quantity = trade.quantity;
      let pnl = 0;

      if (trade.side === 'long') {
        pnl = (exitPrice - entryPrice) * quantity;
      } else {
        pnl = (entryPrice - exitPrice) * quantity;
      }

      // Deduct maker/taker fee
      const fee = exitOrder.fee?.cost || (exitPrice * quantity * 0.0004); // Taker fee (approx 0.04% for demo)
      pnl -= fee;

      console.log(`- Entry Price: $${entryPrice}`);
      console.log(`- Exit Price: $${exitPrice} (Order ID: ${exitOrder.id})`);
      console.log(`- Quantity: ${quantity}`);
      console.log(`- Calculated PnL: $${pnl.toFixed(4)} (Fee: $${fee.toFixed(4)})`);

      // Update trade record
      trade.exitPrice = exitPrice;
      trade.pnl = pnl;
      trade.metadata = {
        ...(trade.metadata || {}),
        exitOrderId: exitOrder.id,
        reconciledAt: new Date()
      };
      await trade.save();

      totalPnL += pnl;
    } catch (err) {
      console.error(`Failed to reconcile ${trade.asset}:`, err.message);
    }
  }

  // Update Portfolio Balance
  console.log(`\nTotal accumulated PnL: $${totalPnL.toFixed(4)}`);
  try {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (portfolio) {
      const oldBalance = portfolio.totalBalance;
      portfolio.totalBalance += totalPnL;
      portfolio.availableBalance = portfolio.totalBalance; // Ensure available matches total since positions are empty
      
      // Update statistics
      portfolio.totalPnl = (portfolio.totalPnl || 0) + totalPnL;
      const winning = totalPnL > 0;
      if (winning) {
        portfolio.winningTrades = (portfolio.winningTrades || 0) + 1;
      } else {
        portfolio.losingTrades = (portfolio.losingTrades || 0) + 1;
      }
      portfolio.totalTrades = (portfolio.totalTrades || 0) + trades.length;
      
      await portfolio.save();
      console.log(`Portfolio Balance updated from $${oldBalance.toFixed(2)} to $${portfolio.totalBalance.toFixed(2)}.`);
    }
  } catch (err) {
    console.error("Failed to update portfolio balance:", err.message);
  }

  console.log("\nReconciliation complete!");
  await mongoose.connection.close();
}

run().catch(console.error);
