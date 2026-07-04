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
  console.log("Placing market sell order for 79.62 LINK on Binance Demo...");
  try {
    const order = await exchange.createOrder(symbol, 'market', 'sell', 79.62, undefined, { reduceOnly: true });
    console.log(`Success! Close order placed: ID=${order.id}`);
  } catch (err) {
    console.error("Failed to close LINK position:", err.message);
  }

  await mongoose.connection.close();
}

run().catch(console.error);
