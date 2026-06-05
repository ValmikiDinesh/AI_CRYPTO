import mongoose from 'mongoose';
import 'dotenv/config';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to database.');

  const mockTradeIds = [
    '6a22b6c4a6fa9daec4a89058', // EPICUSDT
    '6a227aff00350d24380b7be6'  // BOMEUSDT
  ];

  // 1. Update Trade Collection
  console.log('\n--- Updating Trade Collection ---');
  const tradeResult = await Trade.updateMany(
    { _id: { $in: mockTradeIds } },
    { 
      $set: { 
        status: 'cancelled',
        metadata: { closeReason: 'Simulated mismatch cleanup (removed fallback)' }
      } 
    }
  );
  console.log(`Updated ${tradeResult.modifiedCount} trades to 'cancelled' status.`);

  // 2. Remove Open Positions from Portfolio
  console.log('\n--- Updating Portfolio Positions ---');
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (portfolio) {
    const initialPositionsCount = portfolio.positions.length;
    
    // Filter out the open positions that correspond to the mock trades
    const assetsToRemove = ['EPICUSDT', 'BOMEUSDT'];
    const entryPrices = [0.6147, 0.0004147];

    portfolio.positions = portfolio.positions.filter(p => {
      const isMockPosition = p.status === 'open' && 
                             assetsToRemove.includes(p.asset) && 
                             entryPrices.some(price => Math.abs(p.entryPrice - price) < 0.0001);
      
      if (isMockPosition) {
        console.log(`Removing open position: ${p.asset} | Entry Price: $${p.entryPrice}`);
        return false;
      }
      return true;
    });

    console.log(`Positions count: ${initialPositionsCount} -> ${portfolio.positions.length}`);
    await portfolio.save();
    console.log('Portfolio open positions cleaned up.');
  }

  // 3. Recalculate Portfolio Balances
  console.log('\n--- Recalculating Portfolio Balances ---');
  const updatedPortfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (updatedPortfolio) {
    const openPositions = updatedPortfolio.positions.filter(p => p.status === 'open');

    // Calculate true closed PnL
    const closedTrades = await Trade.find({ status: 'closed' });
    let trueTotalPnl = 0;
    let winners = 0;
    let losers = 0;

    closedTrades.forEach(t => {
      const netReturn = (t.pnl || 0) - (t.fees || 0);
      trueTotalPnl += netReturn;
      if (netReturn >= 0) {
        winners++;
      } else {
        losers++;
      }
    });

    const totalClosed = closedTrades.length;

    // Start with starting capital ($1000) + realized returns
    let trueAvailable = 1000 + trueTotalPnl;
    let openExposure = 0;
    let openUnrealized = 0;

    openPositions.forEach(p => {
      const leverage = p.leverage && p.leverage > 1 ? p.leverage : 10;
      const exposure = p.entryPrice * p.quantity;
      const margin = exposure / leverage;
      const entryFee = p.fees || 0;

      trueAvailable -= (margin + entryFee);
      openExposure += margin;
      openUnrealized += p.unrealizedPnl;
    });

    const trueTotalBalance = trueAvailable + openExposure + openUnrealized;

    console.log(`Old availableBalance: $${updatedPortfolio.availableBalance.toFixed(4)}`);
    console.log(`New availableBalance: $${trueAvailable.toFixed(4)}`);
    console.log(`Old totalBalance: $${updatedPortfolio.totalBalance.toFixed(4)}`);
    console.log(`New totalBalance: $${trueTotalBalance.toFixed(4)}`);

    updatedPortfolio.totalPnl = trueTotalPnl;
    updatedPortfolio.availableBalance = trueAvailable;
    updatedPortfolio.totalBalance = trueTotalBalance;
    updatedPortfolio.winningTrades = winners;
    updatedPortfolio.losingTrades = losers;
    updatedPortfolio.totalTrades = totalClosed + openPositions.length;
    updatedPortfolio.winRate = totalClosed > 0 ? winners / totalClosed : 0;

    if (trueTotalBalance > updatedPortfolio.peakBalance) {
      updatedPortfolio.peakBalance = trueTotalBalance;
    }

    await updatedPortfolio.save();
    console.log('Portfolio balances successfully updated and saved.');
  }

  await mongoose.disconnect();
  console.log('\nDatabase disconnected. Cleanup finished successfully.');
}

run().catch(console.error);
