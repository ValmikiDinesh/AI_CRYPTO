import mongoose from 'mongoose';
import connectDB from './config/db.js';
import Portfolio from './models/Portfolio.js';
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
  const closedPositions = portfolio.positions.filter(p => p.status === 'closed');

  // 1. Calculate true closed PnL
  let trueTotalPnl = 0;
  closedPositions.forEach(p => {
    // Net realized PnL = realizedPnl - fees
    trueTotalPnl += (p.realizedPnl - (p.fees || 0));
  });

  // 2. Calculate true available balance
  // Start with $1000 starting capital + realized returns
  let trueAvailable = 1000 + trueTotalPnl;
  
  // Deduct actual collateral and entry fees posted for open positions
  let openExposure = 0;
  let openUnrealized = 0;
  openPositions.forEach(p => {
    // For automated trades that defaulted to 1, we will now assume 10x leverage as well since they are futures trades
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

  // 3. Calculate true total balance (Net Worth)
  // totalBalance = trueAvailable + openExposure + openUnrealized
  const trueTotalBalance = trueAvailable + openExposure + openUnrealized;

  console.log("\n=== RECALCULATED TRUE VALUES ===");
  console.log(`trueTotalPnl: $${trueTotalPnl.toFixed(4)}`);
  console.log(`trueAvailable: $${trueAvailable.toFixed(4)}`);
  console.log(`trueTotalBalance (Net Worth): $${trueTotalBalance.toFixed(4)}`);

  // Safely update portfolio in DB
  portfolio.totalPnl = trueTotalPnl;
  portfolio.availableBalance = trueAvailable;
  portfolio.totalBalance = trueTotalBalance;
  
  // Update win rate and trade counters
  const totalClosed = closedPositions.length;
  const winners = closedPositions.filter(p => p.realizedPnl >= 0).length;
  portfolio.winningTrades = winners;
  portfolio.losingTrades = totalClosed - winners;
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
