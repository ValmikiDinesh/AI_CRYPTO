import connectDB from '../config/db.js';
import { getExchange } from '../services/exchangeService.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  await exchange.loadMarkets();

  const symbols = Object.keys(exchange.markets);
  console.log("Total markets on Binance Demo:", symbols.length);
  
  const wifMarkets = symbols.filter(s => s.toLowerCase().includes('wif'));
  const portalMarkets = symbols.filter(s => s.toLowerCase().includes('portal'));
  
  console.log("Matching WIF markets:", wifMarkets);
  console.log("Matching PORTAL markets:", portalMarkets);
  
  await mongoose.connection.close();
}

run().catch(console.error);
