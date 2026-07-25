import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS, INTERVALS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { fetchCandles, fetchAllTickers } from '../../services/exchangeService.js';
import { coinswitchWs } from '../../services/coinswitchWsService.js';
import MarketData from '../../models/MarketData.js';

/**
 * Market Tracking Agent
 * - Streams live prices from CoinSwitch Socket.IO WebSocket stream.
 * - Publishes structured market events via Redis.
 * - Persists candle data to MongoDB.
 */
export default class MarketAgent extends BaseAgent {
  constructor() {
    super(AGENT_NAMES.MARKET);
    this.prices = {};            // asset → latest price
    this.candles = {};           // asset → latest candle array
    this.pollInterval = null;
    this.lastCandleSync = 0;
  }

  async initialize() {
    await super.initialize();

    // Connect to live CoinSwitch Pro WebSocket stream for sub-second price ticks
    try {
      this.lastEmitted = {};
      coinswitchWs.onPriceUpdate((asset, price) => {
        if (SUPPORTED_ASSETS.includes(asset)) {
          this.prices[asset] = price;
          if (this.candles[asset] && this.candles[asset].length > 0) {
            this.candles[asset][this.candles[asset].length - 1].close = price;
          }
          const now = Date.now();
          if (!this.lastEmitted[asset] || (now - this.lastEmitted[asset]) >= 100) {
            this.lastEmitted[asset] = now;
            publishEvent(CHANNELS.MARKET_DATA, {
              asset,
              price,
              timestamp: now,
              source: 'coinswitch_ws'
            });
          }
        }
      });
      coinswitchWs.connect();
      this.logger.info('⚡ CoinSwitch Pro WebSocket price engine linked to MarketAgent');
    } catch (wsErr) {
      this.logger.warn(`Failed to initialize CoinSwitch WebSocket: ${wsErr.message}`);
    }

    // Load initial historical candles in background asynchronously so server starts INSTANTLY (< 100ms)
    this.preloadCandlesInBackground();
    this.logger.info('🚀 MarketAgent initialized instantly — candle preloading running in background.');
  }

  async preloadCandlesInBackground() {
    try {
      const { default: Portfolio } = await import('../../models/Portfolio.js');
      const portfolio = await Portfolio.findOne({});
      if (portfolio && portfolio.positions) {
        const activeAssets = portfolio.positions.filter(p => p && p.status === 'open').map(p => p.asset);
        for (const asset of activeAssets) {
          try {
            const candles = await fetchCandles(asset, '5m', 100);
            if (candles && candles.length > 0) this.candles[asset] = candles;
          } catch (aErr) {}
        }
      }
    } catch (pErr) {}

    const BATCH_SIZE = 5; // Keep small to avoid HTTP 429 rate limits from CoinSwitch Pro
    for (let i = 0; i < SUPPORTED_ASSETS.length; i += BATCH_SIZE) {
      const batch = SUPPORTED_ASSETS.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (asset) => {
        if (this.candles[asset] && this.candles[asset].length > 0) return;
        try {
          let candles = await fetchCandles(asset, '5m', 100);
          if (!candles || candles.length === 0) {
            const dbCandles = await MarketData.find({ asset, interval: '5m' })
              .sort({ openTime: -1 })
              .limit(100);
            if (dbCandles && dbCandles.length > 0) {
              candles = dbCandles.reverse().map(c => ({
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                openTime: c.openTime,
                closeTime: c.closeTime,
                isClosed: c.isClosed
              }));
            } else {
              candles = [];
            }
          }
          this.candles[asset] = candles;
          if (candles && candles.length > 0) {
            const lastCandle = candles[candles.length - 1];
            this.prices[asset] = lastCandle.close || lastCandle.price || 0;
          }
        } catch (err) {
          this.candles[asset] = [];
        }
      }));
      await new Promise(r => setTimeout(r, 500)); // 500ms throttle between batches to prevent 429 rate limits
    }
    this.logger.info('✅ Background candle preloading complete for all assets.');

    // Start high-performance REST polling loop
    this.pollInterval = setInterval(() => this.pollMarketData(), INTERVALS.ANALYSIS_CYCLE_MS);
    this.logger.info(`CoinSwitch REST polling engine started (${INTERVALS.ANALYSIS_CYCLE_MS / 1000}s frequency)`);
  }

  async pollMarketData() {
    try {
      // 1. Fetch all tickers in one bulk API call
      const tickers = await fetchAllTickers();
      if (!tickers) return;

      // 2. Process all 568 assets in 10 parallel asynchronous batch streams (<300ms cycle)
      const chunkSize = Math.ceil(SUPPORTED_ASSETS.length / 10);
      const assetChunks = [];
      for (let i = 0; i < SUPPORTED_ASSETS.length; i += chunkSize) {
        assetChunks.push(SUPPORTED_ASSETS.slice(i, i + chunkSize));
      }

      const currentAssetIndex = (this.rotationIndex || 0) % SUPPORTED_ASSETS.length;
      this.rotationIndex = currentAssetIndex + 1;
      const syncAsset = SUPPORTED_ASSETS[currentAssetIndex];

      await Promise.all(
        assetChunks.map(async (chunk) => {
          for (const asset of chunk) {
            try {
              const cleanSym = asset.toUpperCase().replace('/', '');
              const ticker = tickers[cleanSym] || tickers[asset.toLowerCase()];
              if (!ticker) continue;

              const price = parseFloat(ticker.last_price || ticker.last || ticker.close || 0);
              if (price <= 0) continue;

              this.prices[asset] = price;

              let candleData = null;

              if (asset === syncAsset) {
                const candles = await fetchCandles(asset, '5m', 1);
                if (candles && candles.length > 0) {
                  const latestCandle = candles[0];
                  latestCandle.close = price;

                  const history = this.candles[asset] || [];
                  const lastHistoryCandle = history[history.length - 1];

                  let isNewCandle = false;
                  if (!lastHistoryCandle || new Date(latestCandle.openTime).getTime() > new Date(lastHistoryCandle.openTime).getTime()) {
                    isNewCandle = true;
                  }

                  candleData = {
                    asset,
                    open: latestCandle.open,
                    high: latestCandle.high,
                    low: latestCandle.low,
                    close: price,
                    volume: latestCandle.volume,
                    openTime: new Date(latestCandle.openTime),
                    closeTime: new Date(latestCandle.closeTime),
                    isClosed: isNewCandle
                  };

                  if (isNewCandle) {
                    try {
                      if (lastHistoryCandle) {
                        lastHistoryCandle.isClosed = true;
                        await MarketData.findOneAndUpdate(
                          { asset, interval: '5m', openTime: lastHistoryCandle.openTime },
                          lastHistoryCandle,
                          { upsert: true, new: true }
                        );
                        await publishEvent(CHANNELS.MARKET_CANDLES, { asset, candle: lastHistoryCandle });
                      }

                      history.push(candleData);
                      if (history.length > 200) history.shift();
                    } catch (dbErr) {
                      this.logger.error(`Failed to persist candle for ${asset}: ${dbErr.message}`);
                    }
                  } else {
                    if (history.length > 0) {
                      history[history.length - 1] = candleData;
                    } else {
                      history.push(candleData);
                    }
                  }
                }
              }

              // Publish live tick to Redis/Socket.io
              await publishEvent(CHANNELS.MARKET_DATA, {
                asset,
                price,
                candle: candleData,
                timestamp: Date.now()
              });
            } catch (err) {
              this.logger.error(`Error processing market tick for ${asset}: ${err.message}`);
            }
          }
        })
      );

      this.lastCandleSync = Date.now();
    } catch (err) {
      this.logger.error(`Error polling market data: ${err.message}`);
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
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    super.stop();
  }
}
