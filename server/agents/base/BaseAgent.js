import { v4 as uuidv4 } from 'uuid';
import { createAgentLogger } from '../../utils/logger.js';

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
      this.intervalMs = intervalMs;
      this.status = 'running';
      this.startedAt = Date.now();
      await this.initialize();
      this.logger.info(`${this.name} agent started — cycle every ${intervalMs}ms`);

      // Run initial cycle in background — boot readiness is signaled by MarketAgent.dataReadyPromise,
      // not by individual agent cycle completion.
      this.runCycle().catch(err => this.logger.error(`${this.name} initial cycle error: ${err.message}`));
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
      // Force-release if stuck for more than 15 seconds
      if (this._cycleStartedAt && (Date.now() - this._cycleStartedAt) > 15000) {
        this.logger.warn(`${this.name} cycle force-released after 15s hang`);
        this.isExecuting = false;
      } else {
        this.logger.debug(`${this.name} cycle skipped — previous cycle still executing`);
        return;
      }
    }
    this.isExecuting = true;
    this._cycleStartedAt = Date.now();
    const start = Date.now();
    try {
      this.lastHeartbeat = Date.now();
      this.cycleCount++;

      // Timeout guard: force-abort if execute() hangs longer than 15s
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Cycle timed out after 15s')), 15000)
      );
      await Promise.race([this.execute(), timeoutPromise]);

      this.status = 'running'; // Reset to running on success
      const duration = Date.now() - start;
      this.logger.info(`Cycle ${this.cycleCount} completed in ${duration}ms`);
    } catch (err) {
      this.status = 'error'; // Set status to error on cycle failure
      this.errors.push(err.message);
      this.logger.error(`${this.name} cycle error: ${err.message}`);
      await this.log('error', 'cycle_error', err.message).catch(() => {});
    } finally {
      this.isExecuting = false;
      this._cycleStartedAt = null;
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

  /** Persist a structured log entry (Redirected to local console/file Winston log). */
  async log(level, action, message, metadata = {}) {
    const metaStr = Object.keys(metadata).length ? ` | metadata: ${JSON.stringify(metadata)}` : '';
    const logMsg = `[${action}] ${message}${metaStr}`;
    
    if (level === 'error') {
      this.logger.error(logMsg);
    } else if (level === 'warn') {
      this.logger.warn(logMsg);
    } else {
      this.logger.info(logMsg);
    }
  }
}
