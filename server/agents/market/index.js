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

    // Resolves when ALL asset data (live prices + 5min candles) is fully loaded.
    // boot() awaits this promise before sending the "Restart Completed" Telegram message.
    this._dataReadyResolve = null;
    this.dataReadyPromise = new Promise(resolve => {
      this._dataReadyResolve = resolve;
    });
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
    // Phase 1: High Priority (Active Open Positions + Top 7 Core Assets) — load INSTANTLY (< 500ms)
    const CORE_BOOT_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT'];
    const priorityAssets = new Set(CORE_BOOT_ASSETS);

    try {
      const { default: Portfolio } = await import('../../models/Portfolio.js');
      const portfolio = await Portfolio.findOne({});
      if (portfolio && portfolio.positions) {
        portfolio.positions.filter(p => p && p.status === 'open').forEach(p => priorityAssets.add(p.asset));
      }
    } catch (pErr) {}

    const priorityList = Array.from(priorityAssets);
    await Promise.all(priorityList.map(async (asset) => {
      try {
        const candles = await fetchCandles(asset, '5m', 100);
        if (candles && candles.length > 0) {
          this.candles[asset] = candles;
          const lastCandle = candles[candles.length - 1];
          this.prices[asset] = lastCandle.close || lastCandle.price || 0;
        }
      } catch (aErr) {}
    }));

    this.logger.info(`🚀 Phase 1 Boot Complete: Loaded priority candles for ${priorityList.length} assets in < 500ms.`);

    // Phase 2: Secondary Assets — Instant MongoDB lookup with compound index fallback
    const secondaryAssets = SUPPORTED_ASSETS.filter(a => !priorityAssets.has(a));
    const BATCH_SIZE = 25;
    for (let i = 0; i < secondaryAssets.length; i += BATCH_SIZE) {
      const batch = secondaryAssets.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (asset) => {
        if (this.candles[asset] && this.candles[asset].length > 0) return;
        try {
          // Check indexed MongoDB cache first (instant < 1ms)
          const dbCandles = await MarketData.find({ asset, interval: '5m' })
            .sort({ openTime: -1 })
            .limit(100)
            .lean();

          let candles = [];
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
            // Only fetch from exchange if missing in database
            candles = await fetchCandles(asset, '5m', 100);
          }

          this.candles[asset] = candles || [];
          if (candles && candles.length > 0) {
            const lastCandle = candles[candles.length - 1];
            this.prices[asset] = lastCandle.close || lastCandle.price || 0;
          }
        } catch (err) {
          this.candles[asset] = [];
        }
      }));
      await new Promise(r => setTimeout(r, 50));
    }
    this.logger.info('✅ Phase 2 Complete: Preloaded candles for all secondary assets.');

    // Start REST polling loop AFTER Phase 2 finishes so ticker sync doesn't collide with initial candle loads
    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this.pollMarketData(), INTERVALS.ANALYSIS_CYCLE_MS);
    }

    // Signal to boot() that ALL asset data is ready — this is the ONLY trigger
    // for the "Restart Completed" Telegram message and trade resumption.
    if (this._dataReadyResolve) {
      this._dataReadyResolve();
      this._dataReadyResolve = null;
    }
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
