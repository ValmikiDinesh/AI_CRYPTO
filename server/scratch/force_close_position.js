import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

// Usage: node scratch/force_close_position.js <ASSET> <CLOSE_PRICE>
// Example: node scratch/force_close_position.js LABUSDT 10.05
async function run() {
  const args = process.argv.slice(2);
  const asset = args[0];
  const closePriceInput = args[1];

  if (!asset) {
    console.error("❌ Please specify the asset symbol (e.g. LABUSDT)");
    process.exit(1);
  }

  await connectDB();

  const portfolio = await Portfolio.findOne({});
  if (!portfolio) {
    console.error("❌ No portfolio found in DB.");
    await mongoose.connection.close();
    process.exit(1);
  }

  const positionIndex = portfolio.positions.findIndex(p => p.asset === asset && p.status === 'open');
  if (positionIndex === -1) {
    console.log(`⚠️ No open position found for ${asset} in the portfolio database.`);
  }

  const activeTrade = await Trade.findOne({ asset, status: 'open' });
  if (!activeTrade) {
    console.log(`⚠️ No open Trade document found for ${asset} in the database.`);
  }

  if (positionIndex === -1 && !activeTrade) {
    console.log("❌ Nothing to close.");
    await mongoose.connection.close();
    process.exit(0);
  }

  const position = positionIndex !== -1 ? portfolio.positions[positionIndex] : null;
  const entryPrice = position ? position.entryPrice : (activeTrade ? activeTrade.entryPrice : 0);
  const quantity = position ? position.quantity : (activeTrade ? activeTrade.quantity : 0);
  const side = position ? position.side : (activeTrade ? activeTrade.side : 'long');
  const leverage = position ? position.leverage : (activeTrade ? activeTrade.leverage : 20);

  const closePrice = closePriceInput ? parseFloat(closePriceInput) : entryPrice;
  console.log(`Closing ${asset} ${side.toUpperCase()} position (Qty: ${quantity}, Entry: $${entryPrice}) at exit price: $${closePrice}...`);

  let realizedPnl = 0;
  if (side === 'long') {
    realizedPnl = (closePrice - entryPrice) * quantity;
  } else {
    realizedPnl = (entryPrice - closePrice) * quantity;
  }

  // Update Trade
  if (activeTrade) {
    activeTrade.status = 'closed';
    activeTrade.exitPrice = closePrice;
    activeTrade.pnl = realizedPnl;
    const initialMargin = (entryPrice * quantity) / leverage;
    activeTrade.pnlPercent = initialMargin > 0 ? (realizedPnl / initialMargin) * 100 : 0;
    activeTrade.closedAt = new Date();
    activeTrade.metadata = { ...(activeTrade.metadata || {}), closeReason: 'Manually forced close via script' };
    activeTrade.markModified('metadata');
    await activeTrade.save();
    console.log("✅ Updated Trade document to CLOSED.");
  }

  // Update Portfolio
  if (position) {
    position.status = 'closed';
    position.closedAt = new Date();
    position.realizedPnl = realizedPnl;
    position.unrealizedPnl = 0;
    
    const initialMargin = (entryPrice * quantity) / leverage;
    const returnValue = initialMargin + realizedPnl; // return margin collateral and pnl
    portfolio.availableBalance += returnValue;

    if (realizedPnl >= 0) {
      portfolio.winningTrades = (portfolio.winningTrades || 0) + 1;
    } else {
      portfolio.losingTrades = (portfolio.losingTrades || 0) + 1;
    }

    const totalClosed = (portfolio.winningTrades || 0) + (portfolio.losingTrades || 0);
    portfolio.winRate = totalClosed > 0 ? portfolio.winningTrades / totalClosed : 0;
    portfolio.totalTrades = totalClosed + portfolio.positions.filter(p => p.status === 'open').length;

    // Recalculate balances
    const openPositions = portfolio.positions.filter(p => p.status === 'open');
    const marginValue = openPositions.reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();
    console.log(`✅ Updated Portfolio. Available Balance: $${portfolio.availableBalance}, Total Balance: $${portfolio.totalBalance}`);
  }

  await mongoose.connection.close();
  console.log("Done.");
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
