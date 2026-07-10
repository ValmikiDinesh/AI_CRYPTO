import '../config/env.js';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({});
  if (!portfolio) {
    console.log('No portfolio found.');
    await mongoose.connection.close();
    return;
  }

  console.log('=== PORTFOLIO ROOT METRICS ===');
  console.log('totalBalance:', portfolio.totalBalance);
  console.log('availableBalance:', portfolio.availableBalance);
  console.log('walletBalance:', portfolio.walletBalance);
  console.log('totalPnl:', portfolio.totalPnl);
  console.log('baseTradingCapital:', portfolio.baseTradingCapital);
  console.log('updatedAt:', portfolio.updatedAt);
  console.log('lastDailyDigestDate:', portfolio.lastDailyDigestDate);
  console.log('isSquaringOff:', portfolio.isSquaringOff);
  console.log('tradingPaused:', portfolio.tradingPaused);


  // Closed trades query
  const allClosed = await Trade.find({ status: 'closed' });
  let totalClosedPnl = 0;
  allClosed.forEach(t => {
    totalClosedPnl += (t.pnl || 0) - (t.fees || 0);
  });
  console.log('\n=== ALL CLOSED TRADES IN DB ===');
  console.log('Total closed trades:', allClosed.length);
  console.log('Total PnL of all closed trades:', totalClosedPnl);

  const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP || '2026-07-04T09:53:00.000Z');
  const closedSinceReset = await Trade.find({ status: 'closed', createdAt: { $gte: resetDate } });
  let trueTotalPnl = 0;
  closedSinceReset.forEach(t => {
    trueTotalPnl += (t.pnl || 0) - (t.fees || 0);
  });
  console.log('\n=== CLOSED TRADES SINCE RESET ===');
  console.log('DASHBOARD_RESET_TIMESTAMP:', process.env.DASHBOARD_RESET_TIMESTAMP);
  console.log('Reset Date object:', resetDate);
  console.log('Number of closed trades since reset:', closedSinceReset.length);
  console.log('Calculated trueTotalPnl:', trueTotalPnl);


  const openPositions = portfolio.positions.filter(p => p && p.status === 'open');
  console.log('\n=== OPEN POSITIONS IN PORTFOLIO ===');
  console.log('Number of open positions:', openPositions.length);

  // Pending trades query
  const pendingTrades = await Trade.find({ status: 'pending' });
  console.log('\n=== PENDING TRADES IN DB ===');
  console.log('Number of pending trades:', pendingTrades.length);
  let pendingMarginTotal = 0;
  let pendingFeesTotal = 0;
  pendingTrades.forEach(t => {
    const leverage = t.leverage && t.leverage > 1 ? t.leverage : 3;
    const exposure = t.entryPrice * t.quantity;
    const margin = exposure / leverage;
    const entryFee = t.fees || 0;
    pendingMarginTotal += margin;
    pendingFeesTotal += entryFee;
  });
  console.log('Sum of margin for pending trades:', pendingMarginTotal);
  console.log('Sum of entry fees for pending trades:', pendingFeesTotal);


  let openMarginTotal = 0;
  let openFeesTotal = 0;
  let openUnrealizedTotal = 0;

  openPositions.forEach(p => {
    const leverage = p.leverage && p.leverage > 1 ? p.leverage : 10;
    const exposure = p.entryPrice * p.quantity;
    const margin = exposure / leverage;
    const entryFee = p.fees || 0;
    openMarginTotal += margin;
    openFeesTotal += entryFee;
    openUnrealizedTotal += (p.unrealizedPnl || 0);
  });

  console.log('Sum of margin for open positions:', openMarginTotal);
  console.log('Sum of entry fees for open positions:', openFeesTotal);
  console.log('Sum of unrealized PnL for open positions:', openUnrealizedTotal);

  // Recalculate true available balance
  const baseCap = portfolio.baseTradingCapital || 1000;
  const wallet = portfolio.walletBalance || 0;
  const trueAvailable = baseCap + trueTotalPnl - wallet - openMarginTotal - openFeesTotal;
  const trueTotalBalance = trueAvailable + openMarginTotal + openUnrealizedTotal;

  console.log('\n=== RECALCULATED BALANCE ===');
  console.log('Recalculated Available Balance:', trueAvailable);
  console.log('Recalculated Total Balance:', trueTotalBalance);
  console.log('Discrepancy (Available):', portfolio.availableBalance - trueAvailable);
  console.log('Discrepancy (Total):', portfolio.totalBalance - trueTotalBalance);

  await mongoose.connection.close();
}

run();
