import connectDB from '../config/db.js';
import { getExchange } from '../services/exchangeService.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  await exchange.loadMarkets();

  const symbol = 'LINK/USDT:USDT';
  const asset = 'LINKUSDT';

  // 1. Fetch and cancel all open orders for LINK
  console.log(`Fetching open orders for ${symbol}...`);
  try {
    const openOrders = await exchange.fetchOpenOrders(symbol);
    console.log(`Found ${openOrders.length} open orders.`);
    for (const o of openOrders) {
      console.log(`Cancelling order ${o.id}...`);
      await exchange.cancelOrder(o.id, symbol);
      console.log(`Successfully cancelled order ${o.id}`);
    }
  } catch (err) {
    console.error(`Error cancelling orders:`, err.message);
  }

  // 2. Fetch active positions to confirm quantity
  let closeQty = 0;
  let side = null;
  try {
    const positions = await exchange.fetchPositions(symbol);
    const linkPos = positions.find(p => p.symbol === symbol && p.contracts > 0);
    if (linkPos) {
      closeQty = linkPos.contracts;
      side = linkPos.side === 'long' ? 'sell' : 'buy';
      console.log(`Active position found on exchange: ${closeQty} units, side: ${linkPos.side}`);
    } else {
      console.log(`No active position found on exchange for ${symbol}.`);
    }
  } catch (err) {
    console.error(`Error fetching positions:`, err.message);
  }

  // 3. Place market close order
  if (closeQty > 0 && side) {
    console.log(`Placing offsetting ${side.toUpperCase()} market order for ${closeQty} units...`);
    try {
      const order = await exchange.createOrder(symbol, 'market', side, closeQty);
      console.log(`Success! Close order placed. Order ID: ${order.id}`);
    } catch (err) {
      console.error(`Error placing close order:`, err.message);
    }
  }

  await mongoose.connection.close();
  console.log("Finished.");
}

run().catch(console.error);
