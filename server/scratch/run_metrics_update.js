import mongoose from 'mongoose';
import 'dotenv/config';
import Portfolio from '../models/Portfolio.js';
import PortfolioAgent from '../agents/portfolio/index.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const portfolio = await Portfolio.findOne({}).sort({ createdAt: 1 });
  console.log('=== PORTFOLIO STATE BEFORE UPDATE ===');
  console.log(`dailyLossToday: ${portfolio.dailyLossToday}`);
  console.log(`totalBalance: ${portfolio.totalBalance}`);
  console.log(`availableBalance: ${portfolio.availableBalance}`);
  console.log(`totalPnl: ${portfolio.totalPnl}`);

  const agent = new PortfolioAgent();
  await agent.updateMetrics(portfolio);

  const updated = await Portfolio.findById(portfolio._id);
  console.log('\n=== PORTFOLIO STATE AFTER UPDATE ===');
  console.log(`dailyLossToday (Daily Net PnL in server): ${updated.dailyLossToday}`);
  console.log(`totalBalance: ${updated.totalBalance}`);
  console.log(`availableBalance: ${updated.availableBalance}`);
  console.log(`totalPnl: ${updated.totalPnl}`);

  await mongoose.disconnect();
}

run().catch(console.error);
