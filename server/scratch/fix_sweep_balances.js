import mongoose from 'mongoose';
import connectDB from './config/db.js';
import Portfolio from './models/Portfolio.js';
import Trade from './models/Trade.js';
import { SYSTEM_USER_ID } from './config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

const RESET_DATE = new Date("2026-07-04T09:53:00.000Z");

async function run() {
  console.log("Connecting to database...");
  await connectDB();
  console.log("Connected!");

  // 1. Fetch Portfolio
  const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
  if (!portfolio) {
    console.error("Portfolio not found!");
    await mongoose.connection.close();
    return;
  }

  // 2. Fetch all closed trades since reset date
  const closedTrades = await Trade.find({
    status: 'closed',
    updatedAt: { $gte: RESET_DATE }
  });

  const sumClosedPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  console.log(`\nClosed trades count since reset: ${closedTrades.length}`);
  console.log(`Sum of closed trades PnL: $${sumClosedPnL.toFixed(4)}`);

  // 3. Reset the fake swept wallet balance back to 0
  const oldWalletBal = portfolio.walletBalance || 0;
  portfolio.walletBalance = 0;

  // 4. Reset base trading capital to what is shown in settings UI
  portfolio.baseTradingCapital = 44.653517564208784;

  // 5. Recalculate portfolio balances
  portfolio.totalPnl = sumClosedPnL;
  portfolio.totalBalance = portfolio.baseTradingCapital + sumClosedPnL;

  // Find remaining open positions and calculate margin
  const openPositions = (portfolio.positions || []).filter(pos => pos.status === 'open');
  let marginInUse = 0;
  openPositions.forEach(pos => {
    const lev = pos.leverage || 5;
    marginInUse += (pos.entryPrice * pos.quantity) / lev;
  });

  const openPositionFees = openPositions.reduce((sum, pos) => sum + (pos.fees || 0), 0);
  portfolio.availableBalance = portfolio.totalBalance - marginInUse - openPositionFees;
  portfolio.peakBalance = portfolio.totalBalance;
  
  // Unpause trading so it can resume normal operations
  portfolio.tradingPaused = false;

  console.log(`\nCorrecting Portfolio Balances:`);
  console.log(`  Base Capital:      $${portfolio.baseTradingCapital.toFixed(4)}`);
  console.log(`  Old Wallet Bal:    $${oldWalletBal.toFixed(4)} -> New Wallet Bal: $${portfolio.walletBalance.toFixed(4)}`);
  console.log(`  New Total PnL:     $${portfolio.totalPnl.toFixed(4)}`);
  console.log(`  New Total Balance: $${portfolio.totalBalance.toFixed(4)}`);
  console.log(`  New Available Bal: $${portfolio.availableBalance.toFixed(4)}`);
  console.log(`  Open Positions:    ${openPositions.map(p => p.asset).join(', ') || 'NONE'}`);
  console.log(`  Trading Paused:    ${portfolio.tradingPaused}`);

  await portfolio.save();
  console.log("\nPortfolio saved successfully!");

  await mongoose.connection.close();
  console.log("Database correction completed!");
}

run().catch(console.error);
