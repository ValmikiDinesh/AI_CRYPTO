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

  // 1. Cancel existing open orders
  console.log("Cancelling existing open orders for LINK...");
  try {
    const openOrders = await exchange.fetchOpenOrders(symbol);
    for (const o of openOrders) {
      await exchange.cancelOrder(o.id, symbol);
      console.log(`Cancelled order ${o.id}`);
    }
  } catch (err) {
    console.error("Error cancelling open orders:", err.message);
  }

  // 2. Fetch current ticker
  let ticker;
  try {
    ticker = await exchange.fetchTicker(symbol);
    console.log(`Current Ticker - Bid: ${ticker.bid}, Ask: ${ticker.ask}, Last: ${ticker.last}`);
  } catch (err) {
    console.error("Error fetching ticker:", err.message);
  }

  // 3. Try to place market order
  console.log("Attempting market sell order first...");
  try {
    const order = await exchange.createOrder(symbol, 'market', 'sell', 79.62, undefined, { reduceOnly: true });
    console.log(`Success! Market close order placed: ID=${order.id}`);
    await mongoose.connection.close();
    return;
  } catch (err) {
    console.warn(`Market order failed: ${err.message}. Retrying with limit order...`);
  }

  // 4. Try limit order at bid or last price
  const sellPrice = ticker?.bid || ticker?.last || 7.90;
  console.log(`Attempting limit sell order at price $${sellPrice}...`);
  try {
    const order = await exchange.createOrder(symbol, 'limit', 'sell', 79.62, sellPrice, { reduceOnly: true });
    console.log(`Success! Limit close order placed: ID=${order.id}, Status=${order.status}`);
  } catch (err) {
    console.error("Limit order also failed:", err.message);
  }

  await mongoose.connection.close();
}

run().catch(console.error);
