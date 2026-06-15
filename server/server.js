import './config/env.js'; // Trigger watch reload
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';

import connectDB from './config/db.js';
import { INTERVALS } from './config/constants.js';
import { logger } from './utils/logger.js';
import errorHandler from './middleware/errorHandler.js';
import { initializeSocketServer } from './websocket/socketManager.js';

// Routes
import authRoutes from './routes/auth.js';
import tradeRoutes from './routes/trade.js';
import portfolioRoutes from './routes/portfolio.js';
import agentRoutes, { setAgentReferences } from './routes/agent.js';
import marketRoutes, { setMarketAgentRef } from './routes/market.js';

// Agents
import SupervisorAgent from './agents/supervisor/index.js';
import MarketAgent from './agents/market/index.js';
import TechnicalAgent from './agents/technical/index.js';
import SentimentAgent from './agents/sentiment/index.js';
import PredictionAgent from './agents/prediction/index.js';
import FusionAgent from './agents/fusion/index.js';
import RiskAgent from './agents/risk/index.js';
import ExecutionAgent from './agents/execution/index.js';
import PortfolioAgent from './agents/portfolio/index.js';
import LearningAgent from './agents/learning/index.js';

// ─── Express App ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());
app.use(morgan('dev'));

// ─── API Routes ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

app.use('/api/auth', authRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/market', marketRoutes);

app.use(errorHandler);

// ─── Boot Sequence ───────────────────────────────────────────────
const PORT = process.env.PORT || 5050;

async function boot() {
  try {
    // 1. Database
    await connectDB();
    logger.info('✅ MongoDB connected');

    // Drop old TTL indexes to apply the new 6-hour TTL options without conflict
    try {
      const db = mongoose.connection.db;
      const collections = await db.listCollections().toArray();
      const colNames = collections.map(c => c.name);

      if (colNames.includes('signals')) {
        await db.collection('signals').dropIndex('createdAt_1');
        logger.info('🔄 Dropped old signals TTL index');
      }
      if (colNames.includes('predictions')) {
        await db.collection('predictions').dropIndex('createdAt_1');
        logger.info('🔄 Dropped old predictions TTL index');
      }
      // Re-trigger index creation to ensure they exist with the new options
      const { default: Signal } = await import('./models/Signal.js');
      const { default: Prediction } = await import('./models/Prediction.js');
      await Signal.ensureIndexes();
      await Prediction.ensureIndexes();
      logger.info('✅ Recreated TTL indexes with 6-hour retention policy');
    } catch (indexErr) {
      logger.warn(`TTL index sync notice: ${indexErr.message}`);
    }

    // 2. Socket.io
    initializeSocketServer(server);
    logger.info('✅ Socket.io initialized');

    // 3. Start HTTP server
    server.listen(PORT, () => {
      logger.info(`✅ Server running on port ${PORT}`);
    });

    // 4. Initialize AI agents
    await bootAgents();
    logger.info('✅ All agents started');

  } catch (err) {
    logger.error(`Boot failed: ${err.message}`);
    process.exit(1);
  }
}

async function bootAgents() {
  // Create agent instances (wiring dependencies)
  const marketAgent = new MarketAgent();
  const technicalAgent = new TechnicalAgent(marketAgent);
  const sentimentAgent = new SentimentAgent();
  const predictionAgent = new PredictionAgent(marketAgent, sentimentAgent, technicalAgent);
  const fusionAgent = new FusionAgent(technicalAgent, sentimentAgent, predictionAgent, marketAgent);
  const riskAgent = new RiskAgent(marketAgent);
  const executionAgent = new ExecutionAgent(fusionAgent, riskAgent, marketAgent);
  const portfolioAgent = new PortfolioAgent(marketAgent, riskAgent);
  const learningAgent = new LearningAgent(fusionAgent);
  const supervisorAgent = new SupervisorAgent();

  // Register all agents with supervisor
  supervisorAgent.registerAgent('market', marketAgent);
  supervisorAgent.registerAgent('technical', technicalAgent);
  supervisorAgent.registerAgent('sentiment', sentimentAgent);
  supervisorAgent.registerAgent('prediction', predictionAgent);
  supervisorAgent.registerAgent('fusion', fusionAgent);
  supervisorAgent.registerAgent('risk', riskAgent);
  supervisorAgent.registerAgent('execution', executionAgent);
  supervisorAgent.registerAgent('portfolio', portfolioAgent);
  supervisorAgent.registerAgent('learning', learningAgent);

  // Inject references into routes
  setAgentReferences(supervisorAgent);
  setMarketAgentRef(marketAgent);

  // Start agents with staggered, decoupled intervals
  await marketAgent.start(5_000);                                // 5s — price refresh
  await technicalAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);       // 5m — technical indicator calculations
  await sentimentAgent.start(600_000);                          // 10m — news sentiment refresh
  await predictionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);      // 5m — AI predictions cycle (aligned with trading cycle)
  await fusionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);          // 5m — decision fusion
  await riskAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);            // 5m — risk verification
  await executionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);       // 5m — trade execution
  await portfolioAgent.start(30_000);                            // 30s — fast database-to-exchange reconciliation
  await learningAgent.start(INTERVALS.REBALANCE_INTERVAL_MS);    // 60s
  await supervisorAgent.start(INTERVALS.HEALTH_CHECK_MS);        // 15s

  logger.info('Agent pipeline: Market → Technical → Sentiment → Prediction → Fusion → Risk → Execution → Portfolio → Learning');
}

// ─── Graceful shutdown ───────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received — starting graceful shutdown`);

  // Set a timeout watchdog to force exit if graceful close hangs
  const forceExitTimeout = setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing process exit');
    process.exit(1);
  }, 2000);
  forceExitTimeout.unref();

  // 1. Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // 2. Disconnect Mongoose
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error(`Error closing MongoDB: ${err.message}`);
  }

  // 3. Close Redis connections (if any)
  try {
    const { getPublisher, getSubscriber } = await import('./config/redis.js');
    const pub = await getPublisher();
    const sub = await getSubscriber();
    if (pub) await pub.quit();
    if (sub) await sub.quit();
    logger.info('Redis connections closed');
  } catch (err) {
    logger.error(`Error closing Redis: ${err.message}`);
  }

  logger.info('Graceful shutdown completed successfully');
  clearTimeout(forceExitTimeout);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled rejection: ${err.stack || err.message}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Unhandled exception: ${err.stack || err.message}`);
});

boot();
