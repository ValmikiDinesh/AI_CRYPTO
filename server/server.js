import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

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
  const predictionAgent = new PredictionAgent(marketAgent);
  const fusionAgent = new FusionAgent(technicalAgent, sentimentAgent, predictionAgent, marketAgent);
  const riskAgent = new RiskAgent(marketAgent);
  const executionAgent = new ExecutionAgent(fusionAgent, riskAgent, marketAgent);
  const portfolioAgent = new PortfolioAgent(marketAgent);
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

  // Start agents with staggered intervals
  await marketAgent.start(30_000);                               // 30s — price refresh
  await technicalAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);       // 60s
  await sentimentAgent.start(INTERVALS.ANALYSIS_CYCLE_MS * 5);   // 5min
  await predictionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS * 2);  // 2min
  await fusionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);          // 60s
  await riskAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);            // 60s
  await executionAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);       // 60s
  await portfolioAgent.start(INTERVALS.ANALYSIS_CYCLE_MS);       // 60s
  await learningAgent.start(INTERVALS.REBALANCE_INTERVAL_MS);    // 5min
  await supervisorAgent.start(INTERVALS.HEALTH_CHECK_MS);        // 30s

  logger.info('Agent pipeline: Market → Technical → Sentiment → Prediction → Fusion → Risk → Execution → Portfolio → Learning');
}

// ─── Graceful shutdown ───────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled rejection: ${err.message}`);
});

boot();
