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
      coinswitchWs.onPriceUpdate((asset, price) => {
        if (SUPPORTED_ASSETS.includes(asset)) {
          this.prices[asset] = price;
          if (this.candles[asset] && this.candles[asset].length > 0) {
            this.candles[asset][this.candles[asset].length - 1].close = price;
          }
          publishEvent(CHANNELS.MARKET_DATA, {
            asset,
            price,
            timestamp: Date.now(),
            source: 'coinswitch_ws'
          });
        }
      });
      coinswitchWs.connect();
      this.logger.info('⚡ CoinSwitch Pro WebSocket price engine linked to MarketAgent');
    } catch (wsErr) {
      this.logger.warn(`Failed to initialize CoinSwitch WebSocket: ${wsErr.message}`);
    }

    // Load initial historical candles via REST (with DB fallback and stagger delay)
    for (const asset of SUPPORTED_ASSETS) {
      try {
        // Stagger requests to prevent concurrent spikes (650ms per asset)
        await new Promise(resolve => setTimeout(resolve, 650));
        
        let candles = await fetchCandles(asset, '5m', 100);
        
        // If API fails to return candles, load from MongoDB fallback
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
            this.logger.info(`Loaded ${candles.length} historical candles from MongoDB fallback for ${asset}`);
          } else {
            candles = [];
            this.logger.warn(`No candles found in Exchange or MongoDB for ${asset}`);
          }
        } else {
          this.logger.info(`Loaded ${candles.length} historical candles from Exchange for ${asset}`);
        }
        
        this.candles[asset] = candles;
        if (candles && candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          this.prices[asset] = lastCandle.close || lastCandle.price || 0;
        }
      } catch (err) {
        this.logger.warn(`Failed to load candles for ${asset}: ${err.message}`);
        this.candles[asset] = [];
      }
    }

    // Start high-performance REST polling loop
    this.pollInterval = setInterval(() => this.pollMarketData(), INTERVALS.ANALYSIS_CYCLE_MS);
    this.logger.info(`CoinSwitch REST polling engine started (${INTERVALS.ANALYSIS_CYCLE_MS / 1000}s frequency)`);
  }

  async pollMarketData() {
    try {
      // 1. Fetch all tickers in one bulk API call
      const tickers = await fetchAllTickers();
      if (!tickers) return;

      // 2. Smoothly rotate single-asset candle sync across cycles to prevent rate limit spikes
      const currentAssetIndex = (this.rotationIndex || 0) % SUPPORTED_ASSETS.length;
      this.rotationIndex = currentAssetIndex + 1;
      const syncAsset = SUPPORTED_ASSETS[currentAssetIndex];

      for (const asset of SUPPORTED_ASSETS) {
        try {
          const cleanSym = asset.toUpperCase().replace('/', '');
          const ticker = tickers[cleanSym] || tickers[asset.toLowerCase()];
          if (!ticker) continue;

          const price = parseFloat(ticker.last_price || ticker.last || ticker.close || 0);
          if (price <= 0) continue;

          this.prices[asset] = price;

          let candleData = null;

          // Only sync candles for the 1 target rotated asset in this cycle
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
          });

        } catch (assetErr) {
          // Silent catch for individual asset loop items
        }
      }

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
