import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, INTERVALS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, escapeHtml } from '../../services/telegramService.js';
import Trade from '../../models/Trade.js';

/**
 * Supervisor Agent
 * - Monitors all agent health.
 * - Publishes health reports.
 * - Can restart failed agents.
 * - Manages emergency shutdown.
 */
export default class SupervisorAgent extends BaseAgent {
  constructor() {
    super(AGENT_NAMES.SUPERVISOR);
    this.agents = new Map();       // name → agent instance
    this.emergencyStop = false;
  }

  registerAgent(name, agentInstance) {
    this.agents.set(name, agentInstance);
    this.logger.info(`Registered agent: ${name}`);
  }

  async initialize() {
    await super.initialize();
    this.logger.info(`Supervisor managing ${this.agents.size} agents`);
  }

  async execute() {
    const healthReport = {};

    for (const [name, agent] of this.agents) {
      const health = agent.getHealth();
      healthReport[name] = health;

      // Restart crashed agents
      if (health.status === 'error' && !this.emergencyStop) {
        this.logger.warn(`Agent ${name} in error state — attempting restart`);
        try {
          agent.stop();
          await agent.start(agent.intervalMs);
          this.logger.info(`Agent ${name} restarted successfully`);
        } catch (err) {
          this.logger.error(`Failed to restart ${name}: ${err.message}`);
        }
      }
    }

    // Calculate accuracies based on closed trades winRate
    let winRate = 0.5;
    try {
      const totalClosed = await Trade.countDocuments({ status: 'closed' });
      if (totalClosed > 0) {
        const winners = await Trade.countDocuments({ status: 'closed', pnl: { $gt: 0 } });
        winRate = winners / totalClosed;
      }
    } catch (err) {
      this.logger.error(`Failed to calculate agent accuracies: ${err.message}`);
    }

    const fusionAgent = this.agents.get('fusion');
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

    // Publish aggregated health to Redis (for frontend consumption)
    await publishEvent(CHANNELS.AGENT_HEALTH, {
      agents: healthReport,
      emergencyStop: this.emergencyStop,
      ensemble,
      timestamp: Date.now(),
    });
  }

  /** Trigger emergency stop — halts all agents. */
  async triggerEmergencyStop(reason = 'Manual trigger') {
    this.emergencyStop = true;
    this.logger.warn(`🚨 EMERGENCY STOP triggered: ${reason}`);

    for (const [name, agent] of this.agents) {
      agent.stop();
      this.logger.info(`Stopped agent: ${name}`);
    }

    // Notify Telegram
    await sendTelegramMessage(
      `🚨 <b>SUPERVISOR EMERGENCY STOP!</b>\n` +
      `<b>All trading agents halted!</b>\n` +
      `<b>Reason</b>: ${escapeHtml(reason)}`
    );

    await publishEvent(CHANNELS.EMERGENCY_STOP, { reason, timestamp: Date.now() });
    await this.log('error', 'emergency_stop', reason);
  }

  /** Resume agents after emergency stop. */
  async resume() {
    this.emergencyStop = false;
    this.logger.info('Resuming agents after emergency stop');

    for (const [name, agent] of this.agents) {
      if (name !== AGENT_NAMES.SUPERVISOR) {
        await agent.start(agent.intervalMs);
      }
    }
  }
}
