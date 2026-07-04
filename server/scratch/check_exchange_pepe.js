import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  await exchange.loadMarkets();
  
  const openOrders = await exchange.fetchOpenOrders('1000PEPE/USDT:USDT');
  console.log(`Open orders on Binance for 1000PEPE: ${openOrders.length}`);
  openOrders.forEach(o => {
    console.log(`- ID: ${o.id}, Symbol: ${o.symbol}, Side: ${o.side}, Qty: ${o.amount}, Price: ${o.price}, Status: ${o.status}`);
  });
  
  await mongoose.connection.close();
}

run().catch(console.error);
