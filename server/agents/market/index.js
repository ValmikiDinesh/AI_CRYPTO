import WebSocket from 'ws';
import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { fetchCandles } from '../../services/exchangeService.js';
import MarketData from '../../models/MarketData.js';

/**
 * Market Tracking Agent
 * - Streams live prices from Binance Futures Testnet via WebSocket.
 * - Publishes structured market events via Redis.
 * - Persists candle data to MongoDB.
 */
export default class MarketAgent extends BaseAgent {
  constructor() {
    super(AGENT_NAMES.MARKET);
    this.ws = null;
    this.prices = {};            // asset → latest price
    this.candles = {};           // asset → latest candle array
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  async initialize() {
    await super.initialize();

    // Load initial historical candles via REST
    for (const asset of SUPPORTED_ASSETS) {
      try {
        const candles = await fetchCandles(asset, '5m', 100);
        this.candles[asset] = candles;
        if (candles && candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          this.prices[asset] = lastCandle.close || lastCandle.price || 0;
        }
        this.logger.info(`Loaded ${candles.length} historical candles for ${asset}`);
      } catch (err) {
        this.logger.warn(`Failed to load candles for ${asset}: ${err.message}`);
        this.candles[asset] = [];
      }
    }

    // Open WebSocket stream
    this.connectWebSocket();
  }

  connectWebSocket() {
    const streams = SUPPORTED_ASSETS
      .map((s) => `${s.toLowerCase()}@kline_5m`)
      .join('/');

    const wsUrl = `${process.env.BINANCE_TESTNET_WS_URL || 'wss://stream.binancefuture.com'}/stream?streams=${streams}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.logger.info('Binance WebSocket connected');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.data && parsed.data.e === 'kline') {
          this.handleKline(parsed.data);
        }
      } catch (err) {
        this.logger.error(`WS message parse error: ${err.message}`);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', () => {
      this.logger.warn('WebSocket closed');
      this.attemptReconnect();
    });
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnect attempts reached — resetting counters and retrying in 30s');
      this.reconnectAttempts = 0;
      setTimeout(() => this.connectWebSocket(), 30000);
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connectWebSocket(), delay);
  }

  async handleKline(data) {
    const kline = data.k;
    const asset = data.s;                      // e.g. "BTCUSDT"
    const price = parseFloat(kline.c);         // close price

    this.prices[asset] = price;

    const candleData = {
      asset,
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: price,
      volume: parseFloat(kline.v),
      quoteVolume: parseFloat(kline.q),
      trades: kline.n,
      openTime: new Date(kline.t),
      closeTime: new Date(kline.T),
      isClosed: kline.x,
    };

    // Publish live tick to Redis
    await publishEvent(CHANNELS.MARKET_DATA, {
      asset,
      price,
      candle: candleData,
    });

    // When candle closes, persist to MongoDB and update local buffer
    if (kline.x) {
      try {
        await MarketData.findOneAndUpdate(
          { asset, interval: '5m', openTime: candleData.openTime },
          candleData,
          { upsert: true, new: true }
        );

        // Keep last 200 candles in memory
        if (!this.candles[asset]) this.candles[asset] = [];
        this.candles[asset].push(candleData);
        if (this.candles[asset].length > 200) this.candles[asset].shift();

        await publishEvent(CHANNELS.MARKET_CANDLES, { asset, candle: candleData });
      } catch (err) {
        this.logger.error(`Failed to persist candle for ${asset}: ${err.message}`);
      }
    }
  }

  /** execute() is called on the recurring interval — used for REST-based updates. */
  async execute() {
    // Refresh prices snapshot for all assets
    const snapshot = {};
    for (const asset of SUPPORTED_ASSETS) {
      snapshot[asset] = {
        price: this.prices[asset] || 0,
        candleCount: this.candles[asset]?.length || 0,
      };
    }

    await publishEvent(CHANNELS.MARKET_DATA, {
      type: 'snapshot',
      assets: snapshot,
    });
  }

  /** Expose current prices for other agents. */
  getPrice(asset) {
    return this.prices[asset] || 0;
  }

  /** Expose candle history for other agents. */
  getCandles(asset) {
    return this.candles[asset] || [];
  }

  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    super.stop();
  }
}
