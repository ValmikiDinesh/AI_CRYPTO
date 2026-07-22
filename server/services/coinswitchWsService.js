import { io } from 'socket.io-client';
import { SUPPORTED_ASSETS } from '../config/constants.js';
import logger from '../utils/logger.js';

class CoinSwitchWsService {
  constructor() {
    this.socket = null;
    this.callbacks = [];
    this.isConnected = false;
    this.latestPrices = {};
  }

  connect() {
    if (this.socket) return;

    logger.info('🔌 Connecting to CoinSwitch Pro Futures WebSocket...');

    this.socket = io('wss://ws.coinswitch.co/exchange_2', {
      path: '/pro/realtime-rates-socket/futures/exchange_2',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      logger.info(`✅ Connected to CoinSwitch Pro WebSocket (ID: ${this.socket.id})`);

      // Subscribe to live price tickers for all supported assets
      SUPPORTED_ASSETS.forEach((asset) => {
        this.socket.emit('FETCH_TICKER_INFO_CS_PRO', { event: 'subscribe', pair: asset });
      });
    });

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      logger.warn(`⚠️ CoinSwitch Pro WebSocket disconnected: ${reason}`);
    });

    this.socket.on('connect_error', (err) => {
      logger.error(`❌ CoinSwitch Pro WebSocket connection error: ${err.message}`);
    });

    this.socket.on('FETCH_TICKER_INFO_CS_PRO', (data) => {
      if (!data || typeof data !== 'object') return;

      Object.keys(data).forEach((symbol) => {
        const item = data[symbol];
        if (item && item.c) {
          const price = parseFloat(item.c);
          if (!isNaN(price) && price > 0) {
            const cleanAsset = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
            this.latestPrices[cleanAsset] = price;
            
            // Notify all registered callbacks
            this.callbacks.forEach((cb) => {
              try {
                cb(cleanAsset, price);
              } catch (e) {
                logger.error(`WebSocket price callback error for ${cleanAsset}: ${e.message}`);
              }
            });
          }
        }
      });
    });
  }

  onPriceUpdate(callback) {
    this.callbacks.push(callback);
  }

  getPrice(asset) {
    return this.latestPrices[asset];
  }
}

export const coinswitchWs = new CoinSwitchWsService();
