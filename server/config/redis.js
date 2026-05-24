import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

// ─── In-memory fallback when Redis is unavailable ────────────────
const memoryBus = new EventEmitter();
memoryBus.setMaxListeners(50);
let redisAvailable = false;

let redisModule = null;
let redisPub = null;
let redisSub = null;

async function tryLoadRedis() {
  try {
    const Redis = (await import('ioredis')).default;
    const testClient = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,       // don't retry during probe
      lazyConnect: true,
      connectTimeout: 3000,
    });

    await testClient.connect();
    await testClient.ping();
    await testClient.quit();

    redisModule = Redis;
    redisAvailable = true;
    logger.info('Redis is available — using Redis Pub/Sub');
  } catch {
    redisAvailable = false;
    logger.warn('Redis not available — falling back to in-memory event bus');
  }
}

// Probe on import
await tryLoadRedis();

function createRedisClient(label) {
  const client = new redisModule({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  client.on('connect', () => logger.info(`Redis [${label}] connected`));
  client.on('error', (err) => logger.error(`Redis [${label}] error: ${err.message}`));
  client.on('close', () => logger.warn(`Redis [${label}] connection closed`));

  return client;
}

export const getPublisher = async () => {
  if (!redisAvailable) return null;
  if (!redisPub) {
    redisPub = createRedisClient('publisher');
    await redisPub.connect();
  }
  return redisPub;
};

export const getSubscriber = async () => {
  if (!redisAvailable) return null;
  if (!redisSub) {
    redisSub = createRedisClient('subscriber');
    await redisSub.connect();
  }
  return redisSub;
};

// Channel names
export const CHANNELS = {
  MARKET_DATA: 'market:data',
  MARKET_CANDLES: 'market:candles',
  MARKET_ORDERBOOK: 'market:orderbook',
  TECHNICAL_SIGNALS: 'agent:technical:signals',
  SENTIMENT_SIGNALS: 'agent:sentiment:signals',
  PREDICTIONS: 'agent:prediction:output',
  FUSED_SIGNALS: 'agent:fusion:signals',
  RISK_EVENTS: 'agent:risk:events',
  TRADE_EXECUTIONS: 'agent:execution:trades',
  PORTFOLIO_UPDATES: 'agent:portfolio:updates',
  AGENT_HEALTH: 'agent:health',
  EMERGENCY_STOP: 'system:emergency_stop',
};

/**
 * Publish an event — uses Redis if available, otherwise in-memory EventEmitter.
 */
export const publishEvent = async (channel, data) => {
  const payload = { timestamp: Date.now(), ...data };

  if (redisAvailable) {
    try {
      const pub = await getPublisher();
      await pub.publish(channel, JSON.stringify(payload));
    } catch (err) {
      logger.error(`Redis publish failed on ${channel}: ${err.message}`);
      // Fallback to memory
      memoryBus.emit(channel, payload);
    }
  } else {
    memoryBus.emit(channel, payload);
  }
};

/**
 * Subscribe to a channel — uses Redis if available, otherwise in-memory EventEmitter.
 */
export const subscribeToChannel = async (channel, handler) => {
  if (redisAvailable) {
    try {
      const sub = await getSubscriber();
      sub.subscribe(channel);
      sub.on('message', (ch, message) => {
        if (ch === channel) {
          try {
            handler(JSON.parse(message));
          } catch (err) {
            logger.error(`Failed to parse message on ${channel}: ${err.message}`);
          }
        }
      });
      return;
    } catch (err) {
      logger.warn(`Redis subscribe failed on ${channel}, falling back to memory: ${err.message}`);
    }
  }

  // In-memory fallback
  memoryBus.on(channel, handler);
};

export const isRedisAvailable = () => redisAvailable;

export default { getPublisher, getSubscriber, publishEvent, subscribeToChannel, CHANNELS, isRedisAvailable };
