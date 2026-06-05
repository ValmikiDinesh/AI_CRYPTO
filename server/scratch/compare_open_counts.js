import mongoose from 'mongoose';
import ccxt from 'ccxt';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to database.');

  // 1. Get open Trades
  const openTrades = await Trade.find({ status: 'open' }).sort({ createdAt: -1 });
  console.log(`\n=== DATABASE OPEN TRADES (${openTrades.length}) ===`);
  openTrades.forEach((t, i) => {
    console.log(`  ${i+1}. TradeID: ${t._id} | Asset: ${t.asset} | Side: ${t.side} | Qty: ${t.quantity} | Entry: $${t.entryPrice} | Created: ${t.createdAt}`);
  });

  // 2. Get open positions in Portfolio
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  const openPositions = portfolio ? portfolio.positions.filter(p => p.status === 'open') : [];
  console.log(`\n=== DATABASE PORTFOLIO OPEN POSITIONS (${openPositions.length}) ===`);
  openPositions.forEach((p, i) => {
    console.log(`  ${i+1}. Asset: ${p.asset} | Side: ${p.side} | Qty: ${p.quantity} | Entry: $${p.entryPrice} | Opened: ${p.openedAt}`);
  });

  // 3. Fetch from Binance Demo
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    secret: process.env.BINANCE_TESTNET_API_SECRET,
    enableRateLimit: true,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    },
  });
  exchange.enableDemoTrading(true);

  console.log('\nFetching active positions from Binance Demo...');
  await exchange.loadMarkets();
  const positions = await exchange.fetchPositions();
  const activeExchangePositions = positions.filter(p => parseFloat(p.contracts) > 0);

  console.log(`\n=== BINANCE DEMO ACTIVE POSITIONS (${activeExchangePositions.length}) ===`);
  activeExchangePositions.forEach((p, i) => {
    const cleanAsset = p.symbol.split(':')[0].replace('/', '');
    console.log(`  ${i+1}. Symbol: ${p.symbol} (Mapped: ${cleanAsset}) | Side: ${p.side} | Qty: ${p.contracts} | Entry: $${p.entryPrice}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
