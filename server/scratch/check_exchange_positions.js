import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const exchange = getExchange();
  await exchange.loadMarkets();
  
  const positions = await exchange.fetchPositions();
  const active = positions.filter(p => parseFloat(p.contracts) > 0);
  console.log(`Active positions on Binance Exchange (${active.length}):`);
  active.forEach(p => {
    console.log(`- Symbol: ${p.symbol}, Size: ${p.contracts}, Side: ${p.side}, Entry: ${p.entryPrice}, UnrealizedPnL: ${p.unrealizedPnl}`);
  });
  
  await mongoose.connection.close();
}

run().catch(console.error);
