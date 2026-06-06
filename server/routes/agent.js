import express from 'express';
import RiskEvent from '../models/RiskEvent.js';
import Trade from '../models/Trade.js';
import { SUPPORTED_ASSETS } from '../config/constants.js';

const router = express.Router();

// Global reference — set by server.js when agents boot
let supervisorAgent = null;

export const setAgentReferences = (supervisor) => {
  supervisorAgent = supervisor;
};

// GET /api/agents/latest-signals — latest cached signals from running agent memory
router.get('/latest-signals', (req, res) => {
  if (!supervisorAgent) {
    return res.status(503).json({ success: false, message: 'Agents not started' });
  }

  const technicalAgent = supervisorAgent.agents.get('technical');
  const sentimentAgent = supervisorAgent.agents.get('sentiment');
  const predictionAgent = supervisorAgent.agents.get('prediction');
  const fusionAgent = supervisorAgent.agents.get('fusion');

  const data = {
    technical: {},
    sentiment: {},
    prediction: {},
    fusion: {},
  };

  const assets = SUPPORTED_ASSETS || [];
  for (const asset of assets) {
    if (technicalAgent) data.technical[asset] = technicalAgent.getLastSignal(asset);
    if (sentimentAgent) data.sentiment[asset] = sentimentAgent.getSentiment(asset);
    if (predictionAgent) data.prediction[asset] = predictionAgent.getPrediction(asset);
    if (fusionAgent) data.fusion[asset] = fusionAgent.getLastSignal(asset);
  }

  res.json({ success: true, data });
});

// GET /api/agents/health — all agents health
router.get('/health', async (req, res) => {
  if (!supervisorAgent) {
    return res.json({ success: true, data: { status: 'not_started' } });
  }

  const agents = {};
  for (const [name, agent] of supervisorAgent.agents) {
    agents[name] = agent.getHealth();
  }

  // Calculate accuracies based on closed trades winRate
  let winRate = 0.5;
  try {
    const closedTrades = await Trade.find({ status: 'closed' });
    const totalClosed = closedTrades.length;
    if (totalClosed > 0) {
      const winners = closedTrades.filter(t => (t.pnl || 0) > 0).length;
      winRate = winners / totalClosed;
    }
  } catch (err) {
    console.error('Failed to calculate agent accuracies in API:', err);
  }

  const fusionAgent = supervisorAgent.agents.get('fusion');
  const weights = fusionAgent?.weights || { technical: 0.40, sentiment: 0.20, prediction: 0.30, momentum: 0.10 };

  const ensemble = {
    technical: {
      weight: weights.technical || 0.40,
      accuracy: Math.max(0.35, Math.min(0.95, winRate * (1.0 + ((weights.technical || 0.40) - 0.3) * 0.5))),
    },
    prediction: {
      weight: weights.prediction || 0.30,
      accuracy: Math.max(0.35, Math.min(0.95, winRate * (1.0 + ((weights.prediction || 0.30) - 0.3) * 0.5))),
    },
    sentiment: {
      weight: weights.sentiment || 0.20,
      accuracy: Math.max(0.35, Math.min(0.95, winRate * (1.0 + ((weights.sentiment || 0.20) - 0.2) * 0.5))),
    },
    momentum: {
      weight: weights.momentum || 0.10,
      accuracy: Math.max(0.35, Math.min(0.95, winRate * 0.9)),
    },
  };

  res.json({
    success: true,
    data: {
      supervisor: supervisorAgent.getHealth(),
      agents,
      emergencyStop: supervisorAgent.emergencyStop,
      ensemble,
    },
  });
});

// POST /api/agents/emergency-stop
router.post('/emergency-stop', async (req, res) => {
  if (!supervisorAgent) {
    return res.status(503).json({ success: false, message: 'Agents not started' });
  }

  const reason = req.body.reason || 'Manual emergency stop from dashboard';
  await supervisorAgent.triggerEmergencyStop(reason);

  res.json({ success: true, message: 'Emergency stop activated', reason });
});

// POST /api/agents/resume
router.post('/resume', async (req, res) => {
  if (!supervisorAgent) {
    return res.status(503).json({ success: false, message: 'Agents not started' });
  }

  await supervisorAgent.resume();
  res.json({ success: true, message: 'Agents resumed' });
});

// POST /api/agents/restart/:name — individually restart a specific agent
router.post('/restart/:name', async (req, res) => {
  if (!supervisorAgent) {
    return res.status(503).json({ success: false, message: 'Agents not started' });
  }

  const { name } = req.params;
  const agent = supervisorAgent.agents.get(name);

  if (!agent) {
    return res.status(404).json({ success: false, message: `Agent node [${name}] not found` });
  }

  try {
    agent.stop();
    // Restart with original interval or fall back to 30-second default
    const restartInterval = agent.intervalMs || 30000;
    await agent.start(restartInterval);
    
    // Log restart event
    await supervisorAgent.log('info', `${name}_restart`, `User manually triggered restart of agent node [${name}] with interval ${restartInterval}ms`);

    res.json({ success: true, message: `Agent node [${name}] restarted successfully (interval: ${restartInterval}ms)` });
  } catch (err) {
    res.status(500).json({ success: false, message: `Failed to restart agent node [${name}]: ${err.message}` });
  }
});

// GET /api/agents/logs — recent agent logs (Database logging is disabled)
router.get('/logs', (req, res) => {
  res.json({ success: true, data: [] });
});

// GET /api/agents/risk-events — recent risk events
router.get('/risk-events', async (req, res, next) => {
  try {
    const { severity, limit = 20 } = req.query;
    const filter = {};
    if (severity) filter.severity = severity;

    const events = await RiskEvent.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
});

export default router;
