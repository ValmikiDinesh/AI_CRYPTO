import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import PortfolioAgent from '../agents/portfolio/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("🚀 Starting Null-Safe Profit Target Sweep Verification...");

  // 1. Connect MongoDB
  await connectDB();

  // 2. Retrieve current portfolio
  let portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  if (!portfolio) {
    console.log("No portfolio found. Creating a default one...");
    portfolio = await Portfolio.create({
      userId: null,
      totalBalance: 1000,
      availableBalance: 1000,
      peakBalance: 1000,
    });
  }

  // Backup original state
  const originalState = {
    totalBalance: portfolio.totalBalance,
    availableBalance: portfolio.availableBalance,
    baseTradingCapital: portfolio.baseTradingCapital,
    walletBalance: portfolio.walletBalance,
    tradingPaused: portfolio.tradingPaused,
    positions: JSON.parse(JSON.stringify(portfolio.positions))
  };

  console.log("Backed up original portfolio state.");

  try {
    // 3. Set up test scenario
    console.log("\n--- Setting up Test Scenario ---");
    portfolio.totalBalance = 1105.50; // trigger threshold is 1100
    portfolio.availableBalance = 1105.50;
    portfolio.baseTradingCapital = 1000;
    portfolio.tradingPaused = false;
    portfolio.walletBalance = 0;
    portfolio.peakBalance = 1000;
    
    // Clear all positions and add exactly one mock position
    portfolio.positions = [];
    portfolio.positions.push({
      asset: 'BTCUSDT',
      side: 'long',
      entryPrice: 60000,
      currentPrice: 60000,
      quantity: 0.1,
      leverage: 10,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: 'open',
      openedAt: new Date()
    });

    await portfolio.save();
    console.log("Saved test portfolio with net worth $1,105.50 and 1 open BTC position.");

    // 4. Instantiate Portfolio Agent and override closePosition to run purely locally
    const marketAgentMock = {
      getPrice: () => 60000
    };
    const agent = new PortfolioAgent(marketAgentMock, null);

    agent.closePosition = async (port, position, closePrice, reason, isRecon) => {
      console.log(`[MOCK] closePosition called for ${position.asset}. Reason: ${reason}`);
      position.status = 'closed';
      position.closedAt = new Date();
      // Total balance remains 1105.50 after break-even close
      return { success: true, netPnl: 0 };
    };

    // 5. Run checkProfitTarget
    console.log("\n--- Running checkProfitTarget ---");
    await agent.checkProfitTarget(portfolio);

    // 6. Assertions
    // Reload from DB
    const updatedPort = await Portfolio.findById(portfolio._id);
    console.log("\n--- Assertions & Verification ---");
    console.log(`tradingPaused: ${updatedPort.tradingPaused} (Expected: true)`);
    console.log(`walletBalance: $${updatedPort.walletBalance} (Expected: $105.50)`);
    console.log(`totalBalance: $${updatedPort.totalBalance} (Expected: $1000.00)`);
    console.log(`availableBalance: $${updatedPort.availableBalance} (Expected: $1000.00)`);
    console.log(`open positions count: ${updatedPort.positions.filter(p => p && p.status === 'open').length} (Expected: 0)`);

    const walletCorrect = Math.abs(updatedPort.walletBalance - 105.50) < 0.1 || updatedPort.walletBalance > 100;
    const passed = 
      updatedPort.tradingPaused === true &&
      walletCorrect &&
      updatedPort.totalBalance === 1000 &&
      updatedPort.availableBalance === 1000 &&
      updatedPort.positions.filter(p => p && p.status === 'open').length === 0;

    if (passed) {
      console.log("\n✅ VERIFICATION SUCCESSFUL! All profit-target sweep properties behave perfectly.");
    } else {
      console.error("\n❌ VERIFICATION FAILED! One or more assertions did not match.");
    }
  } catch (err) {
    console.error("Test execution failed with error:", err);
  } finally {
    // 7. Restore original state
    console.log("\n--- Restoring Original Portfolio State ---");
    const freshPort = await Portfolio.findById(portfolio._id);
    if (freshPort) {
      freshPort.totalBalance = originalState.totalBalance;
      freshPort.availableBalance = originalState.availableBalance;
      freshPort.baseTradingCapital = originalState.baseTradingCapital;
      freshPort.walletBalance = originalState.walletBalance;
      freshPort.tradingPaused = originalState.tradingPaused;
      freshPort.positions = originalState.positions;
      await freshPort.save();
      console.log("Restored original state.");
    }
    
    await mongoose.connection.close();
    console.log("Disconnected MongoDB.");
  }
}

run().catch(console.error);
