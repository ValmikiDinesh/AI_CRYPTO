import { getExchange } from '../services/exchangeService.js';
import connectDB from '../config/db.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  const symbol = 'AVAX/USDT:USDT';

  const orderBook = await exchange.fetchOrderBook(symbol, 5);
  const ticker = await exchange.fetchTicker(symbol);
  const markPrice = ticker.last || ticker.markPrice || ticker.close || 0;

  console.log("=== AVAX Liquidity Check details ===");
  console.log("Mark Price (from fetchTicker):", markPrice);
  console.log("Order Book Bids (Needs bids for Short exit):");
  console.log(orderBook.bids);
  
  if (orderBook.bids && orderBook.bids.length > 0) {
    const bestBid = orderBook.bids[0][0];
    const dev = Math.abs(bestBid - markPrice) / markPrice;
    console.log(`\nBest Bid: ${bestBid}`);
    console.log(`Price Deviation: ${(dev * 100).toFixed(4)}%`);
    console.log(`Is Deviation > 9%?`, dev > 0.09);
  } else {
    console.log("No bids found!");
  }

  await mongoose.connection.close();
}

run().catch(console.error);
