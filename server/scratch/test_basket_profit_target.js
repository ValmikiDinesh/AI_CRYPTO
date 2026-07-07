import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import RiskAgent from '../agents/risk/index.js';
import PortfolioAgent from '../agents/portfolio/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();

  console.log("1. Creating in-memory test portfolio document...");
  // Create an in-memory portfolio to avoid Mongoose validation issues on historical DB entries
  const portfolio = new Portfolio({
    userId: new mongoose.Types.ObjectId(),
    totalBalance: 1000,
    availableBalance: 1000,
    positions: [],
    isSquaringOff: false
  });

  console.log("\n2. Testing RiskAgent validation block when isSquaringOff = true...");
  portfolio.isSquaringOff = true;

  const mockMarketAgent = { getPrice: () => 1.0 };
  const riskAgent = new RiskAgent(mockMarketAgent);
  
  const mockSignal = {
    asset: 'BTCUSDT',
    action: 'BUY',
    confidence: 0.9,
    positionSize: '2%',
    riskScore: 0.2
  };

  const validationResult = await riskAgent.validateTrade(mockSignal, portfolio);
  console.log("Validation Result:", validationResult);
  if (!validationResult.approved && validationResult.reason.includes('reaching $100 profit target')) {
    console.log("✅ RiskAgent successfully blocked trade due to active square-off!");
  } else {
    console.error("❌ RiskAgent failed to block the trade!");
  }

  console.log("\n3. Testing PortfolioAgent basket exit trigger logic...");
  portfolio.isSquaringOff = false;
  // Add two mock open positions with total unrealized profit of $120
  portfolio.positions = [
    {
      asset: 'ETHUSDT',
      side: 'long',
      entryPrice: 1500,
      currentPrice: 1600,
      quantity: 0.5, // 0.5 * 100 = $50 profit
      unrealizedPnl: 50,
      status: 'open'
    },
    {
      asset: 'SOLUSDT',
      side: 'long',
      entryPrice: 50,
      currentPrice: 60,
      quantity: 7, // 7 * 10 = $70 profit
      unrealizedPnl: 70,
      status: 'open'
    }
  ];

  const portfolioAgent = new PortfolioAgent(mockMarketAgent, riskAgent);
  
  // Stub closePosition to avoid placing actual exchange orders or saving to DB
  let closedCount = 0;
  portfolioAgent.closePosition = async (port, pos, closePrice, reason, isReconcile) => {
    console.log(`  [Mocked Close] Position ${pos.asset} closed at $${closePrice}. Reason: ${reason}`);
    pos.status = 'closed';
    closedCount++;
    return { success: true, netPnl: pos.unrealizedPnl || 0 };
  };

  // Mock save to avoid DB call in memory
  portfolio.save = async () => {
    console.log(`  [Mocked Save] Portfolio state saved. isSquaringOff: ${portfolio.isSquaringOff}`);
  };

  console.log("Executing checkExits...");
  await portfolioAgent.checkExits(portfolio);

  console.log("After execution portfolio isSquaringOff flag:", portfolio.isSquaringOff);
  if (portfolio.isSquaringOff === true && closedCount === 2) {
    console.log("✅ PortfolioAgent successfully detected $120 profit, set isSquaringOff to true, and initiated square-off on all positions!");
  } else {
    console.error("❌ PortfolioAgent failed to trigger square-off correctly!");
  }

  console.log("\n4. Testing PortfolioAgent cooldown reset when positions hit 0...");
  // Simulate that all positions are now marked closed
  portfolio.positions.forEach(p => p.status = 'closed');

  console.log("Executing checkExits with all positions closed...");
  await portfolioAgent.checkExits(portfolio);

  console.log("After execution portfolio isSquaringOff flag:", portfolio.isSquaringOff);
  if (portfolio.isSquaringOff === false) {
    console.log("✅ PortfolioAgent successfully reset isSquaringOff to false after all positions were closed!");
  } else {
    console.error("❌ PortfolioAgent failed to reset isSquaringOff flag!");
  }

  await mongoose.connection.close();
  console.log("\nVerification completed successfully.");
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
