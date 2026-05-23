import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, INTERVALS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';

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
          await agent.start(INTERVALS.ANALYSIS_CYCLE_MS);
          this.logger.info(`Agent ${name} restarted successfully`);
        } catch (err) {
          this.logger.error(`Failed to restart ${name}: ${err.message}`);
        }
      }
    }

    // Publish aggregated health to Redis (for frontend consumption)
    await publishEvent(CHANNELS.AGENT_HEALTH, {
      agents: healthReport,
      emergencyStop: this.emergencyStop,
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

    await publishEvent(CHANNELS.EMERGENCY_STOP, { reason, timestamp: Date.now() });
    await this.log('error', 'emergency_stop', reason);
  }

  /** Resume agents after emergency stop. */
  async resume() {
    this.emergencyStop = false;
    this.logger.info('Resuming agents after emergency stop');

    for (const [name, agent] of this.agents) {
      if (name !== AGENT_NAMES.SUPERVISOR) {
        await agent.start(INTERVALS.ANALYSIS_CYCLE_MS);
      }
    }
  }
}
