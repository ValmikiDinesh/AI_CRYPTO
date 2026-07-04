import connectDB from '../config/db.js';
import { getExchange } from '../services/exchangeService.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  await exchange.loadMarkets();

  const wifSymbol = 'WIF/USDT:USDT';
  const portalSymbol = 'PORTAL/USDT:USDT';
  
  const wifTicker = await exchange.fetchTicker(wifSymbol);
  const portalTicker = await exchange.fetchTicker(portalSymbol);
  
  console.log(`Exchange WIF Price: ${wifTicker.last} (Bid: ${wifTicker.bid}, Ask: ${wifTicker.ask})`);
  console.log(`Exchange PORTAL Price: ${portalTicker.last} (Bid: ${portalTicker.bid}, Ask: ${portalTicker.ask})`);
  
  await mongoose.connection.close();
}

run().catch(console.error);
