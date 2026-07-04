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
  try {
    const ticker = await exchange.fetchTicker(symbol);
    console.log(`Current Ticker for ${symbol}:`, JSON.stringify(ticker, null, 2));
    
    // Try to place a limit sell order at the ticker last price or slightly lower to trigger a match
    const targetPrice = ticker.last || 7.946;
    console.log(`Placing limit sell order for 79.62 LINK at price $${targetPrice}...`);
    
    const order = await exchange.createOrder(symbol, 'limit', 'sell', 79.62, targetPrice, { reduceOnly: true });
    console.log(`Success! Limit close order placed: ID=${order.id}, Status=${order.status}`);
  } catch (err) {
    console.error("Failed to place limit close order:", err.message);
  }

  await mongoose.connection.close();
}

run().catch(console.error);
