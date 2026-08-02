import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack, agent }) => {
  const agentTag = agent ? ` [${agent}]` : '';
  return `${timestamp} ${level}${agentTag}: ${stack || message}`;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5_000_000,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10_000_000,
      maxFiles: 5,
    }),
  ],
});

// Custom Transport for Redis Broadcasting
class RedisTransport extends winston.Transport {
  constructor(opts) {
    super(opts);
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    
    // Only broadcast agent logs
    if (info.agent) {
      // Lazily import to avoid circular dependency
      import('../config/redis.js').then(({ publishEvent, CHANNELS }) => {
        publishEvent(CHANNELS.AGENT_LOGS, {
          agent: info.agent,
          level: info.level,
          message: info.message,
          timestamp: info.timestamp || new Date().toISOString()
        }).catch(() => {});
      }).catch(() => {});
    }

    callback();
  }
}

logger.add(new RedisTransport({ level: 'info' }));

// Create agent-specific child logger
export const createAgentLogger = (agentName) => {
  return logger.child({ agent: agentName });
};

export default logger;
