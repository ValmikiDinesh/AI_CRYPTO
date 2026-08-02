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
import { sendTelegramMessage } from './services/telegramService.js';
import { initializeTelegramBot } from './services/telegramBot.js';
import { scheduleDailyDigest } from './jobs/dailyDigest.js';
import { initReportingCron } from './services/reportingService.js';
import { setSystemWarmingUp, getSystemWarmingUp } from './config/bootState.js';

// Routes
import authRoutes from './routes/auth.js';
import tradeRoutes from './routes/trade.js';
import portfolioRoutes, { setPortfolioAgentRef } from './routes/portfolio.js';
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
import LearningAgent from './agents/learning/index.js';

// New Microservices (Replacing Execution & Portfolio monoliths)
import OmsAgent from './agents/oms/index.js';
import EmsAgent from './agents/ems/index.js';
import StopLossAgent from './agents/stoploss/index.js';
import TakeProfitAgent from './agents/takeprofit/index.js';
import ScalpProfitAgent from './agents/scalp/index.js';
import TrailingSlAgent from './agents/trailing/index.js';
import ReconciliationAgent from './agents/reconciliation/index.js';
import SweepProfitAgent from './agents/sweep/index.js';
import BasketProfitAgent from './agents/basket/index.js';

// ─── Express App ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
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
    // 1. Mark system as warming up and notify Telegram immediately
    setSystemWarmingUp(true);
    await sendTelegramMessage(
      `🔄 <b>Server Restarting / Initializing System...</b>\n\n` +
      `New trade execution is temporarily <b>PAUSED</b> while all asset feeds, market data, and AI models load.\n\n` +
      `<i>System is in cooling/preparation period...</i>`
    );

    // 2. Database
    await connectDB();
    logger.info('✅ MongoDB connected');

    // 3. Socket.io
    await initializeTelegramBot();
    initializeSocketServer(server);
    logger.info('✅ Socket.io initialized');

    // 4. Start HTTP server
    server.listen(PORT, () => {
      logger.info(`✅ Server running on port ${PORT}`);
    });

    // 5. Initialize all AI agents (non-blocking — agents start their cycles in background)
    const marketAgent = await bootAgents();
    logger.info('✅ All agents initialized and running');
    
    // 5b. Schedule background jobs
    scheduleDailyDigest();
    logger.info('✅ Daily Telegram Digest scheduled for 00:00 IST');

    // 6. Wait for ALL asset data to be fully loaded (live prices + 5min candles for 566+ assets).
    //    This is the ONLY readiness gate — no fake delays, no guessing.
    //    MarketAgent.dataReadyPromise resolves ONLY when preloadCandlesInBackground() Phase 2 completes.
    logger.info('⏳ Waiting for MarketAgent to finish loading all asset data (live prices + 5min candles)...');
    await marketAgent.dataReadyPromise;
    logger.info('✅ All asset data loaded — live prices and 5min candles ready for all assets');

    // 7. Complete warmup and resume trading
    setSystemWarmingUp(false);
    const { SUPPORTED_ASSETS } = await import('./config/constants.js');
    await sendTelegramMessage(
      `✅ <b>Server Restart Completed Successfully!</b>\n\n` +
      `All ${SUPPORTED_ASSETS.length}+ crypto asset feeds (live prices + 5min candles), AI consensus models, and market indicators are fully loaded and operational.\n\n` +
      `🚀 <b>New trade execution has RESUMED! System working normally.</b>`
    );

    // 8. Removed old reporting CRON in favor of dailyDigest
    // initReportingCron();

  } catch (err) {
    logger.error(`Boot failed: ${err.message}`);
    process.exit(1);
  }
}

async function bootAgents() {
  // Create core agent instances
  const marketAgent = new MarketAgent();
  const technicalAgent = new TechnicalAgent(marketAgent);
  const sentimentAgent = new SentimentAgent();
  const predictionAgent = new PredictionAgent(marketAgent, sentimentAgent, technicalAgent);
  const fusionAgent = new FusionAgent(technicalAgent, sentimentAgent, predictionAgent, marketAgent);
  const riskAgent = new RiskAgent(marketAgent);
  const learningAgent = new LearningAgent(fusionAgent);
  const supervisorAgent = new SupervisorAgent();

  // Create Microservices
  const omsAgent = new OmsAgent(riskAgent);
  const emsAgent = new EmsAgent();
  const stopLossAgent = new StopLossAgent();
  const takeProfitAgent = new TakeProfitAgent();
  const scalpAgent = new ScalpProfitAgent();
  const trailingSlAgent = new TrailingSlAgent();
  const reconciliationAgent = new ReconciliationAgent();
  const sweepAgent = new SweepProfitAgent();
  const basketAgent = new BasketProfitAgent();

  // Register all agents with supervisor
  supervisorAgent.registerAgent('market', marketAgent);
  supervisorAgent.registerAgent('technical', technicalAgent);
  supervisorAgent.registerAgent('sentiment', sentimentAgent);
  supervisorAgent.registerAgent('prediction', predictionAgent);
  supervisorAgent.registerAgent('fusion', fusionAgent);
  supervisorAgent.registerAgent('risk', riskAgent);
  supervisorAgent.registerAgent('learning', learningAgent);
  
  supervisorAgent.registerAgent('oms', omsAgent);
  supervisorAgent.registerAgent('ems', emsAgent);
  supervisorAgent.registerAgent('stoploss', stopLossAgent);
  supervisorAgent.registerAgent('takeprofit', takeProfitAgent);
  supervisorAgent.registerAgent('scalp', scalpAgent);
  supervisorAgent.registerAgent('trailing', trailingSlAgent);
  supervisorAgent.registerAgent('reconciliation', reconciliationAgent);
  supervisorAgent.registerAgent('sweep', sweepAgent);
  supervisorAgent.registerAgent('basket', basketAgent);

  // Inject references into routes
  setAgentReferences(supervisorAgent);
  setMarketAgentRef(marketAgent);
  // NOTE: Portfolio API routes might need refactoring later to get balances directly, 
  // but we provide a dummy ref for now to prevent crashes.
  setPortfolioAgentRef({ 
    _cachedPortfolio: null,
    marketAgent: marketAgent,
    syncClosedTradesFromExchange: async () => {} 
  }); 

  // Start Core Agents
  await marketAgent.start(5_000);                                // 5s — price refresh
  await technicalAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);       // technical indicator calculations
  await sentimentAgent.start(600_000);                           // 10m — news sentiment refresh
  await predictionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);      // AI predictions cycle
  await fusionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);          // decision fusion
  await riskAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);            // risk verification
  await learningAgent.start(INTERVALS.REBALANCE_INTERVAL_MS);   // 60s
  await supervisorAgent.start(INTERVALS.HEALTH_CHECK_MS);       // 15s

  // Initialize Microservices (Event-driven, no polling loops passed to start)
  await omsAgent.start();
  await emsAgent.start();
  await stopLossAgent.start();
  await takeProfitAgent.start();
  await scalpAgent.start();
  await trailingSlAgent.start();
  await reconciliationAgent.start();
  await sweepAgent.start();
  await basketAgent.start();

  logger.info('Agent pipeline: Market → Technical → Sentiment → Prediction → Fusion → Risk → OMS → EMS');

  // Return marketAgent so boot() can await its dataReadyPromise
  global.supervisorRef = supervisorAgent;
  return marketAgent;
}

// ─── Graceful shutdown ───────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received — starting graceful shutdown`);

  try {
    await sendTelegramMessage(`⚠️ <b>Trading Bot Stopping!</b>\nSignal received: ${signal}. Graceful shutdown initiated.`);
  } catch (tgErr) {
    logger.error(`Failed to send shutdown Telegram message: ${tgErr.message}`);
  }

  // Set a timeout watchdog to force exit if graceful close hangs
  const forceExitTimeout = setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing process exit');
    process.exit(1);
  }, 2000);
  forceExitTimeout.unref();

  // 1. Stop all agent execution cycles first before closing DB connection
  if (global.supervisorRef) {
    try {
      global.supervisorRef.stopAll();
      logger.info('All agents stopped');
    } catch (sErr) {}
  }

  // 2. Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // 3. Disconnect Mongoose
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
