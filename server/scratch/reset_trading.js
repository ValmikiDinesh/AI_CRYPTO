import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import Signal from '../models/Signal.js';
import Prediction from '../models/Prediction.js';
import RiskEvent from '../models/RiskEvent.js';
import { getExchange } from '../services/exchangeService.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Starting full reset of trading agents, MongoDB, and Binance...");

  // 1. Connect MongoDB
  await connectDB();

  // 2. CCXT Exchange connection
  let exchange;
  try {
    exchange = getExchange();
    await exchange.loadMarkets();
    console.log("Connected to Binance Futures Demo Exchange via CCXT");
  } catch (err) {
    console.error("Failed to connect to Exchange: ", err.message);
  }

  // 3. Close positions and cancel orders on Binance Demo
  if (exchange) {
    // 3.1. Cancel all open orders for all supported assets
    const { SUPPORTED_ASSETS } = await import('../config/constants.js');
    console.log("Cancelling all open orders on Binance...");
    for (const asset of SUPPORTED_ASSETS) {
      try {
        await exchange.cancelAllOrders(asset);
        console.log(`\u200b\u0007 Cancelled all orders for ${asset}`);
      } catch (err) {
        console.log(`No open orders or failed to cancel for ${asset}: ${err.message}`);
      }
    }

    // 3.2. Fetch and close active positions
    try {
      console.log("Fetching active positions from Binance...");
      const positions = await exchange.fetchPositions();
      const activePositions = positions.filter((p) => parseFloat(p.contracts) > 0);
      console.log(`Found ${activePositions.length} active positions on Binance`);

      for (const pos of activePositions) {
        const symbol = pos.symbol;
        const contracts = parseFloat(pos.contracts);
        const side = pos.side; // 'long' or 'short'
        const exitSide = side === 'long' ? 'sell' : 'buy';

        console.log(`Closing position for ${symbol}: ${side} of size ${contracts}`);
        try {
          const order = await exchange.createMarketOrder(symbol, exitSide, contracts);
          console.log(`Closed position for ${symbol}. Order ID: ${order.id}`);
        } catch (err) {
          console.error(`Failed to close position for ${symbol}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error("Failed to process positions: ", err.message);
    }
  }

  // 4. MongoDB Database cleanup
  console.log("Cleaning up MongoDB database...");
  try {
    // Delete all predictions, signals, risk events, and trades
    const tradesDel = await Trade.deleteMany({});
    const signalsDel = await Signal.deleteMany({});
    const predictionsDel = await Prediction.deleteMany({});
    const riskDel = await RiskEvent.deleteMany({});
    console.log(`Deleted ${tradesDel.deletedCount} Trades`);
    console.log(`Deleted ${signalsDel.deletedCount} Signals`);
    console.log(`Deleted ${predictionsDel.deletedCount} Predictions`);
    console.log(`Deleted ${riskDel.deletedCount} RiskEvents`);

    // Reset portfolio to clean $1000 baseline
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (portfolio) {
      portfolio.positions = [];
      portfolio.totalBalance = 1000;
      portfolio.availableBalance = 1000;
      portfolio.totalPnl = 0;
      portfolio.totalPnlPercent = 0;
      portfolio.winningTrades = 0;
      portfolio.losingTrades = 0;
      portfolio.totalTrades = 0;
      portfolio.winRate = 0;
      portfolio.dailyLossToday = 0;
      portfolio.peakBalance = 1000;
      portfolio.allocationBreakdown = [];
      portfolio.walletBalance = 0;
      portfolio.tradingPaused = false;
      portfolio.targetProfitThreshold = 1100;
      portfolio.baseTradingCapital = 1000;
      await portfolio.save();
      console.log("Reset Portfolio baseline to $1,000 net worth");
    } else {
      await Portfolio.create({
        userId: SYSTEM_USER_ID,
        totalBalance: 1000,
        availableBalance: 1000,
        totalPnl: 0,
        totalPnlPercent: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalTrades: 0,
        winRate: 0,
        dailyLossToday: 0,
        peakBalance: 1000,
        positions: [],
        allocationBreakdown: [],
        walletBalance: 0,
        tradingPaused: false,
        targetProfitThreshold: 1100,
        baseTradingCapital: 1000,
      });
      console.log("Created fresh Portfolio baseline with $1,000 capital");
    }
  } catch (err) {
    console.error("MongoDB cleanup failed: ", err.message);
  }

  console.log("Full reset completed successfully!");
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
