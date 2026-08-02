import { Server } from 'socket.io';
import { subscribeToChannel, CHANNELS } from '../config/redis.js';
import { logger } from '../utils/logger.js';

let io = null;

/**
 * Initialize Socket.io server and wire up Redis → WebSocket bridge.
 */
export const initializeSocketServer = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    socket.on('subscribe:asset', (asset) => {
      socket.join(`asset:${asset}`);
      logger.debug(`${socket.id} subscribed to asset:${asset}`);
    });

    socket.on('unsubscribe:asset', (asset) => {
      socket.leave(`asset:${asset}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Client disconnected: ${socket.id}`);
    });
  });

  // Bridge Redis Pub/Sub events to Socket.io rooms
  bridgeRedisToSocket();

  logger.info('Socket.io server initialized');
  return io;
};

/**
 * Subscribe to Redis channels and forward events to connected clients.
 */
async function bridgeRedisToSocket() {
  try {
    // Market data → all clients
    await subscribeToChannel(CHANNELS.MARKET_DATA, (data) => {
      io.emit('market:data', data);
      if (data.asset) {
        io.to(`asset:${data.asset}`).emit('market:tick', data);
      }
    });

    // Candle closed → asset room
    await subscribeToChannel(CHANNELS.MARKET_CANDLES, (data) => {
      if (data.asset) {
        io.to(`asset:${data.asset}`).emit('market:candle', data);
      }
    });

    // Technical signals → all clients
    await subscribeToChannel(CHANNELS.TECHNICAL_SIGNALS, (data) => {
      io.emit('signal:technical', data);
    });

    // Sentiment signals → all clients
    await subscribeToChannel(CHANNELS.SENTIMENT_SIGNALS, (data) => {
      io.emit('signal:sentiment', data);
    });

    // Predictions → all clients
    await subscribeToChannel(CHANNELS.PREDICTIONS, (data) => {
      io.emit('signal:prediction', data);
    });

    // Fused signals → all clients
    await subscribeToChannel(CHANNELS.FUSED_SIGNALS, (data) => {
      io.emit('signal:fused', data);
    });

    // Risk events → all clients
    await subscribeToChannel(CHANNELS.RISK_EVENTS, (data) => {
      io.emit('risk:event', data);
    });

    // Trade executions → all clients
    await subscribeToChannel(CHANNELS.TRADE_EXECUTIONS, (data) => {
      io.emit('trade:execution', data);
    });

    // Portfolio updates → all clients
    await subscribeToChannel(CHANNELS.PORTFOLIO_UPDATES, (data) => {
      io.emit('portfolio:update', data);
    });

    // Agent health → all clients
    await subscribeToChannel(CHANNELS.AGENT_HEALTH, (data) => {
      io.emit('agents:health', data);
    });

    // Agent logs → all clients
    await subscribeToChannel(CHANNELS.AGENT_LOGS, (data) => {
      io.emit('agent:log', data);
    });

    // Emergency stop → all clients
    await subscribeToChannel(CHANNELS.EMERGENCY_STOP, (data) => {
      io.emit('system:emergency', data);
    });

    logger.info('Redis → Socket.io bridge established for all channels');
  } catch (err) {
    logger.error(`Failed to bridge Redis to Socket.io: ${err.message}`);
  }
}

export const getIO = () => io;

export default { initializeSocketServer, getIO };
