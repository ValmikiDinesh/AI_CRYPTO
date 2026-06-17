import mongoose from 'mongoose';
import connectDB from './config/db.js';
import Portfolio from './models/Portfolio.js';
import Trade from './models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (!portfolio) {
    console.log("No portfolio found!");
    await mongoose.connection.close();
    return;
  }

  console.log("=== CURRENT PORTFOLIO IN DB ===");
  console.log(`totalBalance (Net Worth): $${portfolio.totalBalance.toFixed(4)}`);
  console.log(`availableBalance: $${portfolio.availableBalance.toFixed(4)}`);
  console.log(`totalPnl: $${portfolio.totalPnl.toFixed(4)}`);

  const openPositions = portfolio.positions.filter(p => p.status === 'open');

  // 1. Calculate true closed PnL and trade counters from Trade collection (the absolute source of truth)
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

  // 2. Calculate true available balance
  // Start with $1000 starting capital + realized returns
  let trueAvailable = 1000 + trueTotalPnl;
  
  // Deduct actual collateral and entry fees posted for open positions
  let openExposure = 0;
  let openUnrealized = 0;
  openPositions.forEach(p => {
    const leverage = p.leverage && p.leverage > 1 ? p.leverage : 10;
    
    // Exposure value = entryPrice * quantity
    const exposure = p.entryPrice * p.quantity;
    // Collateral posted (margin required) = exposure / leverage
    const margin = exposure / leverage;
    const entryFee = p.fees || 0;
    
    trueAvailable -= (margin + entryFee); // Corrected to deduct leveraged margin
    openExposure += margin; // Corrected to count posted margin
    openUnrealized += p.unrealizedPnl;
  });

  // Deduct margin and fees for pending limit orders
  let pendingMargin = 0;
  const pendingTrades = await Trade.find({ status: 'pending' });
  pendingTrades.forEach(t => {
    const leverage = t.leverage && t.leverage > 1 ? t.leverage : 3;
    const exposure = t.entryPrice * t.quantity;
    const margin = exposure / leverage;
    const entryFee = t.fees || 0;
    trueAvailable -= (margin + entryFee);
    pendingMargin += (margin + entryFee);
  });

  // 3. Calculate true total balance (Net Worth)
  const trueTotalBalance = trueAvailable + pendingMargin + openExposure + openUnrealized;

  console.log("\n=== RECALCULATED TRUE VALUES ===");
  console.log(`trueTotalPnl: $${trueTotalPnl.toFixed(4)}`);
  console.log(`trueAvailable: $${trueAvailable.toFixed(4)}`);
  console.log(`trueTotalBalance (Net Worth): $${trueTotalBalance.toFixed(4)}`);
  console.log(`winners: ${winners}, losers: ${losers}, totalClosed: ${totalClosed}`);

  // Safely update portfolio in DB
  portfolio.totalPnl = trueTotalPnl;
  portfolio.availableBalance = trueAvailable;
  portfolio.totalBalance = trueTotalBalance;
  
  // Update win rate and trade counters
  portfolio.winningTrades = winners;
  portfolio.losingTrades = losers;
  portfolio.totalTrades = totalClosed + openPositions.length;
  portfolio.winRate = totalClosed > 0 ? winners / totalClosed : 0;
  
  // Adjust peakBalance if needed
  if (trueTotalBalance > portfolio.peakBalance) {
    portfolio.peakBalance = trueTotalBalance;
  } else if (portfolio.peakBalance > 1500) { // Reset peakBalance if it was inflated by the bug
    portfolio.peakBalance = Math.max(1000, trueTotalBalance);
  }

  await portfolio.save();
  console.log("\nPORTFOLIO SUCCESSFULLY RE-CALCULATED AND UPDATED IN DATABASE!");

  await mongoose.connection.close();
}

run().catch(console.error);
