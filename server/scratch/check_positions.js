import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  console.log('=== CURRENT ACTIVE POSITIONS IN PORTFOLIO ===');
  if (portfolio && portfolio.positions) {
    const openPositions = portfolio.positions.filter(p => p.status === 'open');
    console.log(`Found ${openPositions.length} open positions:`);
    for (const p of openPositions) {
      console.log(`Asset: ${p.asset} | Side: ${p.side} | Entry: ${p.entryPrice} | Qty: ${p.quantity} | PnL: ${p.unrealizedPnl} | OpenedAt: ${p.openedAt.toISOString()}`);
    }
  } else {
    console.log('No portfolio or positions found');
  }

  await mongoose.disconnect();
}

run().catch(console.error);
