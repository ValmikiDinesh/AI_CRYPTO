import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  console.log('=== CURRENT ACTIVE POSITIONS IN PORTFOLIO ===');
  if (portfolio && portfolio.positions) {
    const openPositions = portfolio.positions.filter(p => p.status === 'open');
    console.log(`Found ${openPositions.length} open positions:`);
    for (const p of openPositions) {
      console.log(`Asset: ${p.asset} | Side: ${p.side} | Entry: ${p.entryPrice} | Qty: ${p.quantity} | PnL: ${p.unrealizedPnl} | SL: ${p.stopLoss} | TP: ${p.takeProfit} | OpenedAt: ${p.openedAt.toISOString()}`);
    }
  } else {
    console.log('No portfolio or positions found');
  }

  const openTrades = await Trade.find({ status: 'open' });
  console.log('\n=== CURRENT OPEN TRADES IN DATABASE ===');
  console.log(`Found ${openTrades.length} open trades:`);
  for (const t of openTrades) {
    console.log(`ID: ${t._id} | Asset: ${t.asset} | Side: ${t.side} | Entry: ${t.entryPrice} | Qty: ${t.quantity} | SL: ${t.stopLoss} | TP: ${t.takeProfit} | Reasoning: ${t.reasoning}`);
  }

  await mongoose.disconnect();
}

run().catch(console.error);
