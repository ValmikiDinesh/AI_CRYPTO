import express from 'express';
import AgentLog from '../models/AgentLog.js';
import RiskEvent from '../models/RiskEvent.js';

const router = express.Router();

// Global reference — set by server.js when agents boot
let supervisorAgent = null;

export const setAgentReferences = (supervisor) => {
  supervisorAgent = supervisor;
};

// GET /api/agents/health — all agents health
router.get('/health', (req, res) => {
  if (!supervisorAgent) {
    return res.json({ success: true, data: { status: 'not_started' } });
  }

  const agents = {};
  for (const [name, agent] of supervisorAgent.agents) {
    agents[name] = agent.getHealth();
  }

  res.json({
    success: true,
    data: {
      supervisor: supervisorAgent.getHealth(),
      agents,
      emergencyStop: supervisorAgent.emergencyStop,
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
    // Restart with 30-second default cycle
    await agent.start(30000);
    
    // Log restart event
    await supervisorAgent.log('info', `${name}_restart`, `User manually triggered restart of agent node [${name}]`);

    res.json({ success: true, message: `Agent node [${name}] restarted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: `Failed to restart agent node [${name}]: ${err.message}` });
  }
});

// GET /api/agents/logs — recent agent logs
router.get('/logs', async (req, res, next) => {
  try {
    const { agent, level, limit = 50 } = req.query;
    const filter = {};
    if (agent) filter.agent = agent;
    if (level) filter.level = level;

    const logs = await AgentLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, data: logs });
  } catch (err) {
    next(err);
  }
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
