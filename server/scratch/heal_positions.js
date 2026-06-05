import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to database.');

  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (!portfolio) {
    console.log('No portfolio found');
    await mongoose.disconnect();
    return;
  }

  let healedCount = 0;
  if (portfolio.positions) {
    for (const position of portfolio.positions) {
      if (position.status === 'open' && (position.stopLoss === undefined || position.takeProfit === undefined)) {
        console.log(`Open position with missing SL/TP found for: ${position.asset}`);
        
        // Find matching open trade
        const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
        if (activeTrade) {
          console.log(`  Matching Trade found! Copying SL: ${activeTrade.stopLoss} and TP: ${activeTrade.takeProfit}`);
          position.stopLoss = activeTrade.stopLoss;
          position.takeProfit = activeTrade.takeProfit;
          healedCount++;
        } else {
          console.log(`  No matching open Trade found for ${position.asset}`);
        }
      }
    }
  }

  if (healedCount > 0) {
    await portfolio.save();
    console.log(`Successfully healed ${healedCount} open positions in Portfolio.`);
  } else {
    console.log('No positions needed healing.');
  }

  await mongoose.disconnect();
}

run().catch(console.error);
