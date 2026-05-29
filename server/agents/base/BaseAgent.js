import { v4 as uuidv4 } from 'uuid';
import { createAgentLogger } from '../../utils/logger.js';
import AgentLog from '../../models/AgentLog.js';

/**
 * BaseAgent — abstract base class for all AI agents.
 * Provides lifecycle management, health reporting, and structured logging.
 */
export default class BaseAgent {
  constructor(name) {
    this.name = name;
    this.id = uuidv4();
    this.status = 'idle';         // idle | running | error | stopped
    this.logger = createAgentLogger(name);
    this.startedAt = null;
    this.lastHeartbeat = null;
    this.cycleCount = 0;
    this.errors = [];
    this._interval = null;
    this.isExecuting = false;
  }

  /** Override in subclass — one-time initialization */
  async initialize() {
    this.logger.info(`${this.name} agent initialized (id=${this.id})`);
  }

  /** Override in subclass — the main work loop */
  async execute() {
    throw new Error(`${this.name}.execute() not implemented`);
  }

  /** Start the agent on a recurring interval. */
  async start(intervalMs) {
    try {
      this.status = 'running';
      this.startedAt = Date.now();
      await this.initialize();
      this.logger.info(`${this.name} agent started — cycle every ${intervalMs}ms`);

      // Run immediately, then on interval
      await this.runCycle();
      this._interval = setInterval(() => this.runCycle(), intervalMs);
    } catch (err) {
      this.status = 'error';
      this.errors.push(err.message);
      this.logger.error(`${this.name} failed to start: ${err.message}`);
    }
  }

  /** Single execution cycle with error handling and logging. */
  async runCycle() {
    if (this.isExecuting) {
      this.logger.debug(`${this.name} cycle skipped — previous cycle still executing`);
      return;
    }
    this.isExecuting = true;
    const start = Date.now();
    try {
      this.lastHeartbeat = Date.now();
      this.cycleCount++;
      await this.execute();
      const duration = Date.now() - start;

      await this.log('info', 'cycle_complete', `Cycle ${this.cycleCount} completed`, { duration });
    } catch (err) {
      this.errors.push(err.message);
      this.logger.error(`${this.name} cycle error: ${err.message}`);
      await this.log('error', 'cycle_error', err.message);
    } finally {
      this.isExecuting = false;
    }
  }

  /** Stop the agent. */
  stop() {
    if (this._interval) clearInterval(this._interval);
    this.status = 'stopped';
    this.logger.info(`${this.name} agent stopped`);
  }

  /** Get health status. */
  getHealth() {
    return {
      name: this.name,
      id: this.id,
      status: this.status,
      startedAt: this.startedAt,
      lastHeartbeat: this.lastHeartbeat,
      cycleCount: this.cycleCount,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      recentErrors: this.errors.slice(-5),
    };
  }

  /** Persist a structured log entry to MongoDB. */
  async log(level, action, message, metadata = {}) {
    try {
      await AgentLog.create({
        agent: this.name,
        level,
        action,
        message,
        ...metadata,
      });
    } catch (err) {
      this.logger.error(`Failed to persist agent log: ${err.message}`);
    }
  }
}
