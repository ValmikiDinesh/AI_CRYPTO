import connectDB from '../config/db.js';
import { getExchange } from '../services/exchangeService.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  await exchange.loadMarkets();
  
  console.log("Attempting to cancel orphaned order 582804762 on exchange...");
  try {
    const result = await exchange.cancelOrder('582804762', '1000PEPE/USDT:USDT');
    console.log("Order successfully cancelled:", result);
  } catch (err) {
    console.error("Failed to cancel order:", err.message);
  }
  
  await mongoose.connection.close();
}

run().catch(console.error);
