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
    const openOrders = await exchange.fetchOpenOrders(symbol);
    console.log(`Open orders for ${symbol}:`, openOrders.length);
    openOrders.forEach(o => {
      console.log(`- ID: ${o.id}, Type: ${o.type}, Side: ${o.side}, Qty: ${o.amount}, Price: ${o.price}, StopPrice: ${o.stopPrice}`);
    });
  } catch (err) {
    console.error(`Failed to fetch open orders for ${symbol}:`, err.message);
  }

  try {
    const position = await exchange.fetchPositions(symbol);
    console.log(`Position info for ${symbol}:`, JSON.stringify(position, null, 2));
  } catch (err) {
    console.error(`Failed to fetch position info for ${symbol}:`, err.message);
  }

  await mongoose.connection.close();
}

run().catch(console.error);
