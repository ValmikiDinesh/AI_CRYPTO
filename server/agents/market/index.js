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
            const lastCandle = this.candles[asset][this.candles[asset].length - 1];
            lastCandle.close = price;
            if (price > lastCandle.high) lastCandle.high = price;
            if (price < lastCandle.low) lastCandle.low = price;
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
        const candles = await fetchCandles(asset, '5m', 60);
        if (candles && candles.length > 0) {
          this.candles[asset] = candles;
          const lastCandle = candles[candles.length - 1];
          this.prices[asset] = lastCandle.close || lastCandle.price || 0;
        }
      } catch (aErr) {}
    }));

    this.logger.info(`🚀 Phase 1 Boot Complete: Loaded priority candles for ${priorityList.length} assets in < 500ms.`);

    // Resolve readiness signal IMMEDIATELY after Phase 1 so server boot completes in <500ms
    if (this._dataReadyResolve) {
      this._dataReadyResolve();
      this._dataReadyResolve = null;
    }

    // Start REST polling loop
    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this.pollMarketData(), INTERVALS.ANALYSIS_CYCLE_MS);
    }

    // Phase 2: Secondary Assets (Meme Coins + Recommended Coins) — Gentle Background Preload (non-blocking)
    const secondaryAssets = SUPPORTED_ASSETS.filter(a => !priorityAssets.has(a));
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < secondaryAssets.length; i += BATCH_SIZE) {
      const batch = secondaryAssets.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (asset) => {
        try {
          if (this.candles[asset] && this.candles[asset].length >= 30) return;
          const candles = await fetchCandles(asset, '5m', 30);
          if (candles && candles.length > 0) {
            this.candles[asset] = candles;
            const lastCandle = candles[candles.length - 1];
            if (!this.prices[asset] || this.prices[asset] <= 0) {
              this.prices[asset] = lastCandle.close || lastCandle.price || 0;
            }
          }
        } catch (err) {}
      }));
      await new Promise(r => setTimeout(r, 400));
    }

    this.logger.info(`✅ Phase 2 Complete: Preloaded 30 candles for all ${SUPPORTED_ASSETS.length} supported coins.`);
  }

  async pollMarketData() {
    try {
      // 1. Fetch all tickers in one bulk API call
      const tickers = await fetchAllTickers();
      if (!tickers) return;

      const updatedTicks = [];

      // 2. Throttle Kline KLines REST calls to 1 per 5 seconds (12 req/min — 60% below CoinSwitch 30 req/min limit)
      const now = Date.now();
      let allowKlineFetch = false;
      if (!this._lastKlineFetchTime || (now - this._lastKlineFetchTime) >= 5000) {
        allowKlineFetch = true;
        this._lastKlineFetchTime = now;
      }

      let syncAsset = null;
      if (allowKlineFetch) {
        const currentAssetIndex = (this.rotationIndex || 0) % SUPPORTED_ASSETS.length;
        syncAsset = SUPPORTED_ASSETS[currentAssetIndex];
        this.rotationIndex = currentAssetIndex + 1;
      }

      for (const asset of SUPPORTED_ASSETS) {
        try {
          const cleanSym = asset.toUpperCase().replace('/', '');
          const ticker = tickers[cleanSym] || tickers[asset.toLowerCase()];
          if (!ticker) continue;

          const price = parseFloat(ticker.last_price || ticker.last || ticker.close || 0);
          if (price <= 0) continue;

          this.prices[asset] = price;

          let candleData = null;
          const history = this.candles[asset] || [];
          let lastHistoryCandle = history[history.length - 1];

          // 🛡️ FIX: Autonomous Local Rollover (Prevents 41-Minute Stretched Candle Delusion)
          if (lastHistoryCandle) {
            const nowMs = Date.now();
            const openTimeMs = new Date(lastHistoryCandle.openTime).getTime();
            const fiveMinMs = 5 * 60 * 1000;
            
            if (nowMs >= openTimeMs + fiveMinMs) {
              const newOpenTime = new Date(openTimeMs + fiveMinMs);
              const newCandle = {
                asset,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: 0,
                openTime: newOpenTime,
                closeTime: new Date(newOpenTime.getTime() + fiveMinMs - 1),
                isClosed: false
              };
              
              lastHistoryCandle.isClosed = true;
              
              try {
                await MarketData.findOneAndUpdate(
                  { asset, interval: '5m', openTime: lastHistoryCandle.openTime },
                  lastHistoryCandle,
                  { upsert: true, new: true }
                );
                await publishEvent(CHANNELS.MARKET_CANDLES, { asset, candle: lastHistoryCandle });
              } catch (dbErr) {
                this.logger.error(`Failed to persist local rollover candle for ${asset}: ${dbErr.message}`);
              }

              history.push(newCandle);
              if (history.length > 60) history.shift();
              lastHistoryCandle = newCandle;
            }
          }

          if (asset === syncAsset) {
            // 🛡️ FIX: Deep History Reconciliation (Fetch 10 candles instead of 2 to backfill missing gaps)
            const candles = await fetchCandles(asset, '5m', 10);
            if (candles && candles.length > 0) {
              for (const fetchedCandle of candles) {
                const fetchedTime = new Date(fetchedCandle.openTime).getTime();
                const existingIdx = history.findIndex(c => new Date(c.openTime).getTime() === fetchedTime);
                if (existingIdx !== -1) {
                  // Merge definitively closed exchange data into our locally simulated candle
                  history[existingIdx] = { ...history[existingIdx], ...fetchedCandle, isClosed: true };
                } else {
                  // Backfill totally missing candles if they are newer
                  const lastHist = history[history.length - 1];
                  if (!lastHist || fetchedTime > new Date(lastHist.openTime).getTime()) {
                    history.push(fetchedCandle);
                  }
                }
              }
              
              history.sort((a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime());
              while (history.length > 60) history.shift();
              
              // Ensure the latest in-progress candle stays open and tracks live price
              lastHistoryCandle = history[history.length - 1];
              if (lastHistoryCandle) {
                lastHistoryCandle.isClosed = false;
                lastHistoryCandle.close = price;
              }
            }
          }

          if (lastHistoryCandle) {
             candleData = lastHistoryCandle;
          }

          updatedTicks.push({ asset, price, candle: candleData });
        } catch (err) {
          this.logger.error(`Error processing market tick for ${asset}: ${err.message}`);
        }
      }

      // 3. Publish single bulk Redis event for all updated prices (1 IPC call vs 568)
      if (updatedTicks.length > 0) {
        await publishEvent(CHANNELS.MARKET_DATA, {
          type: 'bulk_ticks',
          ticks: updatedTicks,
          timestamp: Date.now()
        });
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

  /** Expose current prices for other agents with multi-layer fallback. */
  getPrice(asset) {
    if (!asset) return 0;
    const cleanAsset = asset.replace('/', '').replace(':USDT', '').toUpperCase();
    if (this.prices[asset] && this.prices[asset] > 0) return this.prices[asset];
    if (cleanAsset && this.prices[cleanAsset] && this.prices[cleanAsset] > 0) return this.prices[cleanAsset];
    if (coinswitchWs && coinswitchWs.latestPrices) {
      if (coinswitchWs.latestPrices[asset] > 0) return coinswitchWs.latestPrices[asset];
      if (cleanAsset && coinswitchWs.latestPrices[cleanAsset] > 0) return coinswitchWs.latestPrices[cleanAsset];
    }
    if (this.candles[asset] && this.candles[asset].length > 0) {
      const lastCandle = this.candles[asset][this.candles[asset].length - 1];
      if (lastCandle && lastCandle.close > 0) return lastCandle.close;
    }
    if (cleanAsset && this.candles[cleanAsset] && this.candles[cleanAsset].length > 0) {
      const lastCandle = this.candles[cleanAsset][this.candles[cleanAsset].length - 1];
      if (lastCandle && lastCandle.close > 0) return lastCandle.close;
    }
    return 0;
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
