import axios from 'axios';
import crypto from 'crypto';
import Portfolio from '../models/Portfolio.js';
import { SYSTEM_USER_ID } from '../config/constants.js';
import { logger } from '../utils/logger.js';

class CoinSwitchExchange {
  constructor() {
    this.baseUrl = 'https://coinswitch.co/trade/api/v2';
    this.isDemo = true;
    this.markets = {};
    this.timeOffset = 0;
    this.leverageCache = new Map(); // symbol -> leverage (already set this session)
    this.positionsCache = {};
    this.allTickersCache = null;
    this.ohlcvCache = {};
    // Global request throttle: minimum 350ms between any two private API calls
    this._lastRequestTime = 0;
    this._requestQueue = Promise.resolve();
    this.syncTimeOffset();
  }

  async syncTimeOffset() {
    try {
      const res = await axios.get('https://coinswitch.co/trade/api/v2/time');
      const serverTime = res.data?.serverTime || res.data?.data?.serverTime;
      if (serverTime) {
        this.timeOffset = serverTime - Date.now();
        logger.info(`CoinSwitch clock drift offset calculated: ${this.timeOffset} ms`);
      }
    } catch (err) {
      logger.error(`CoinSwitch syncTimeOffset error: ${err.message}`);
    }
  }

  enableDemoTrading(isDemo) {
    this.isDemo = isDemo;
  }

  async loadMarkets() {
    // Return standard supported assets with their limits/precisions as baseline fallbacks
    this.markets = {
      'BTCUSDT': { precision: { amount: 3, price: 2 }, limits: { amount: { min: 0.001, step: 0.001, max: 100 } }, symbol: 'BTCUSDT' },
      'ETHUSDT': { precision: { amount: 2, price: 2 }, limits: { amount: { min: 0.01, step: 0.01, max: 1000 } }, symbol: 'ETHUSDT' },
      'BNBUSDT': { precision: { amount: 2, price: 2 }, limits: { amount: { min: 0.01, step: 0.01, max: 1000 } }, symbol: 'BNBUSDT' },
      'SOLUSDT': { precision: { amount: 2, price: 2 }, limits: { amount: { min: 0.01, step: 0.01, max: 1000 } }, symbol: 'SOLUSDT' },
      'XRPUSDT': { precision: { amount: 1, price: 4 }, limits: { amount: { min: 0.1, step: 0.1, max: 10000 } }, symbol: 'XRPUSDT' },
      'ADAUSDT': { precision: { amount: 1, price: 4 }, limits: { amount: { min: 0.1, step: 0.1, max: 10000 } }, symbol: 'ADAUSDT' },
      'LINKUSDT': { precision: { amount: 2, price: 3 }, limits: { amount: { min: 0.01, step: 0.01, max: 1000 } }, symbol: 'LINKUSDT' },
      'DOGEUSDT': { precision: { amount: 1, price: 5 }, limits: { amount: { min: 0.1, step: 0.1, max: 100000 } }, symbol: 'DOGEUSDT' },
    };

    if (!this.isDemo) {
      try {
        const path = '/futures/instrument_info?exchange=EXCHANGE_2';
        const auth = await this._signRequest('GET', path);
        if (auth) {
          const res = await axios.get(`https://coinswitch.co/trade/api/v2${path}`, auth);
          if (res.data && res.data.data) {
            for (const [symbol, info] of Object.entries(res.data.data)) {
              const cleanSym = symbol.toUpperCase().replace('/', '');
              this.markets[cleanSym] = {
                symbol: cleanSym,
                precision: {
                  amount: info.quantity_precision,
                  price: info.price_precision
                },
                limits: {
                  amount: {
                    min: parseFloat(info.min_base_quantity || 0),
                    step: parseFloat(info.base_quantity_step_size || 0)
                  },
                  cost: {
                    min: 2.0
                  }
                }
              };
            }
            logger.info(`✅ Loaded ${Object.keys(res.data.data).length} dynamic market instruments from CoinSwitch Pro`);
          }
        }
      } catch (err) {
        logger.warn(`Failed to dynamically load instrument info from CoinSwitch: ${err.message}. Using baseline fallback markets.`);
      }
    }
    return this.markets;
  }

  market(symbol) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    return this.markets[cleanSym] || { precision: { amount: 3, price: 2 }, symbol: cleanSym };
  }

  amountToPrecision(symbol, amount) {
    if (amount === undefined || amount === null || isNaN(parseFloat(amount))) return '0';
    const num = parseFloat(amount);
    if (num <= 0) return '0';

    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    let dec = this.markets[cleanSym]?.precision?.amount;
    if (dec === undefined || dec === null) dec = 3;

    let formatted = num.toFixed(dec);
    if (parseFloat(formatted) === 0 && num > 0) {
      for (let d = dec + 1; d <= 8; d++) {
        formatted = num.toFixed(d);
        if (parseFloat(formatted) > 0) break;
      }
    }
    return formatted;
  }

  priceToPrecision(symbol, price) {
    if (price === undefined || price === null || isNaN(parseFloat(price))) return '0';
    const num = parseFloat(price);
    if (num <= 0) return '0';

    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    let dec = this.markets[cleanSym]?.precision?.price;
    if (dec === undefined || dec === null) {
      if (num < 0.0001) dec = 8;
      else if (num < 0.01) dec = 6;
      else if (num < 1) dec = 4;
      else dec = 2;
    }

    let formatted = num.toFixed(dec);
    if (parseFloat(formatted) === 0 && num > 0) {
      for (let d = dec + 1; d <= 8; d++) {
        formatted = num.toFixed(d);
        if (parseFloat(formatted) > 0) break;
      }
    }
    return formatted;
  }

  // Generate Ed25519 signature for CoinSwitch Pro API
  async _signRequest(method, path, body = {}) {
    try {
      const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
      const apiKey = portfolio?.coinSwitchApiKey;
      const apiSecret = portfolio?.coinSwitchApiSecret;

      if (!apiKey || !apiSecret) {
        return null;
      }

      const fullPath = path.startsWith('/trade/api/v2') ? path : `/trade/api/v2${path}`;
      const decodedPath = decodeURIComponent(fullPath.replace(/\+/g, ' '));
      const epoch = (Date.now() + this.timeOffset).toString();

      // Official Ed25519 signature formula: METHOD + decodedPath + epoch
      const message = method.toUpperCase() + decodedPath + epoch;

      let privateKeyBuffer = Buffer.from(apiSecret, 'hex');
      if (apiSecret.length === 64) {
        const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
        privateKeyBuffer = Buffer.concat([prefix, privateKeyBuffer]);
      }

      const signature = crypto.sign(
        null,
        Buffer.from(message, 'utf-8'),
        {
          key: privateKeyBuffer,
          format: 'der',
          type: 'pkcs8'
        }
      );

      return {
        headers: {
          'X-AUTH-APIKEY': apiKey,
          'X-AUTH-SIGNATURE': signature.toString('hex'),
          'X-AUTH-EPOCH': epoch,
          'Content-Type': 'application/json'
        }
      };
    } catch (err) {
      logger.error(`CoinSwitch request signing failed: ${err.message}`);
      return null;
    }
  }

  // Global throttle: ensures minimum gap between private API calls to stay under rate limits
  async _throttle() {
    return new Promise(resolve => {
      this._requestQueue = this._requestQueue.then(async () => {
        const now = Date.now();
        const elapsed = now - this._lastRequestTime;
        const minGap = 600; // minimum 600ms between API requests
        if (elapsed < minGap) {
          await new Promise(r => setTimeout(r, minGap - elapsed));
        }
        this._lastRequestTime = Date.now();
        resolve();
      });
    });
  }

  // Execute authenticated requests with rate-limit retry support (exponential backoff on 429)
  async _requestWithRetry(method, path, body = {}, maxAttempts = 4) {
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        await this._throttle();
        const auth = await this._signRequest(method, path, body);
        const url = `https://coinswitch.co/trade/api/v2${path}`;
        let res;
        
        if (method.toUpperCase() === 'GET') {
          res = await axios.get(url, auth || {});
        } else if (method.toUpperCase() === 'DELETE') {
          res = await axios.delete(url, { ...(auth || {}), data: body });
        } else {
          res = await axios.post(url, body, auth || {});
        }
        return res;
      } catch (err) {
        attempts++;
        const status = err.response?.status;
        
        if (status === 429 && attempts < maxAttempts) {
          const delay = 3000 * attempts;
          logger.warn(`⚠️ CoinSwitch Pro 429 Rate Limit on ${method} ${path}. Retrying attempt ${attempts}/${maxAttempts} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
  }

  // REST API: Public fetchAllTickers
  async fetchAllTickers() {
    const now = Date.now();
    if (this.allTickersCache && (now - this.allTickersCache.timestamp < 3000)) {
      return this.allTickersCache.data;
    }

    try {
      const res = await this._requestWithRetry('GET', '/futures/all-pairs/ticker?exchange=EXCHANGE_2');
      if (res.data && res.data.data) {
        this.allTickersCache = { timestamp: now, data: res.data.data };
        return res.data.data;
      }
      throw new Error('Invalid CoinSwitch response structure');
    } catch (err) {
      // Fallback: Fetch from public Binance Futures API for all tickers
      try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/24hr`);
        if (res.data && Array.isArray(res.data)) {
          const map = {};
          res.data.forEach(t => {
            map[t.symbol] = {
              symbol: t.symbol,
              last_price: t.lastPrice,
              last: t.lastPrice,
              highPrice24h: t.highPrice,
              lowPrice24h: t.lowPrice,
              volume24h: t.volume
            };
          });
          this.allTickersCache = { timestamp: now, data: map };
          return map;
        }
        throw new Error('Invalid Binance response structure');
      } catch (binanceErr) {
        if (this.allTickersCache) return this.allTickersCache.data;
        logger.error(`fetchAllTickers fallback error: ${binanceErr.message}`);
        return {};
      }
    }
  }

  // REST API: Public fetchTicker
  async fetchTicker(symbol) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    try {
      const path = `/futures/ticker?symbol=${cleanSym}&exchange=EXCHANGE_2`;
      const res = await this._requestWithRetry('GET', path);
      if (res.data && res.data.data) {
        const resData = res.data.data;
        const t = resData.EXCHANGE_2 || resData[Object.keys(resData)[0]];
        if (t) {
          return {
            symbol: symbol,
            last: parseFloat(t.lastPrice || t.last_price || t.last || t.close || 0),
            bid: parseFloat(t.bidPrice || t.best_bid_price || t.bid || 0),
            ask: parseFloat(t.askPrice || t.best_ask_price || t.ask || 0),
            high: parseFloat(t.highPrice || t.high_price_24h || t.high || 0),
            low: parseFloat(t.lowPrice || t.low_price_24h || t.low || 0),
            volume: parseFloat(t.volume || t.volume24h || t.base_asset_volume_24h || 0),
            markPrice: parseFloat(t.markPrice || t.mark_price || t.last_price || 0)
          };
        }
      }
      throw new Error('Invalid CoinSwitch response structure');
    } catch (err) {
      logger.error(`fetchTicker error for ${symbol}: ${err.message}`);
      throw err;
    }
  }

  // REST API: Public fetchOHLCV
  async fetchOHLCV(symbol, timeframe = '5m', since, limit = 100) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    const intervalMap = {
      '1m': '1',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '2h': '120',
      '4h': '240',
      '1d': '1440'
    };
    const cleanInterval = intervalMap[timeframe] || timeframe.replace('m', '').replace('h', '').replace('d', '');
    const now = Date.now();
    const cachePrefix = `${cleanSym}_${timeframe}_`;

    for (const [key, cacheObj] of Object.entries(this.ohlcvCache)) {
      if (key.startsWith(cachePrefix) && (now - cacheObj.timestamp < 120000)) {
        if (cacheObj.data && Array.isArray(cacheObj.data) && cacheObj.data.length >= limit) {
          return cacheObj.data.slice(-limit);
        }
      }
    }

    const cacheKey = `${cleanSym}_${timeframe}_${limit}`;
    try {
      const path = `/futures/klines?symbol=${cleanSym}&interval=${cleanInterval}&limit=${limit}&exchange=EXCHANGE_2`;
      const res = await this._requestWithRetry('GET', path);
      const klines = res.data.data || res.data;
      if (klines && Array.isArray(klines)) {
        const result = klines.map(c => [
          parseInt(c.start_time || c.time || c.timestamp),
          parseFloat(c.o || c.open),
          parseFloat(c.h || c.high),
          parseFloat(c.l || c.low),
          parseFloat(c.c || c.close),
          parseFloat(c.volume)
        ]);
        this.ohlcvCache[cacheKey] = { timestamp: now, data: result };
        return result;
      }
      throw new Error('Invalid CoinSwitch response structure');
    } catch (err) {
      // Fallback: Fetch from public Binance Futures API
      try {
        const limitParam = limit || 100;
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSym}&interval=${timeframe}&limit=${limitParam}`);
        if (res.data && Array.isArray(res.data)) {
          const result = res.data.map(c => [
            parseFloat(c[0]), // openTime
            parseFloat(c[1]), // open
            parseFloat(c[2]), // high
            parseFloat(c[3]), // low
            parseFloat(c[4]), // close
            parseFloat(c[5])  // volume
          ]);
          this.ohlcvCache[cacheKey] = { timestamp: now, data: result };
          return result;
        }
        throw new Error('Invalid Binance response structure');
      } catch (binanceErr) {
        if (this.ohlcvCache[cacheKey]) return this.ohlcvCache[cacheKey].data;
        logger.error(`fetchOHLCV fallback error for ${symbol}: ${binanceErr.message}`);
        return [];
      }
    }
  }

  // REST API: Public fetchOrderBook
  async fetchOrderBook(symbol, limit = 20) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    try {
      const res = await this._requestWithRetry('GET', `/futures/order_book?exchange=EXCHANGE_2&symbol=${cleanSym}`);
      if (res.data && res.data.data) {
        const d = res.data.data;
        const bids = (d.bids || []).slice(0, limit).map(b => [parseFloat(b[0]), parseFloat(b[1])]);
        const asks = (d.asks || []).slice(0, limit).map(a => [parseFloat(a[0]), parseFloat(a[1])]);
        return { bids, asks };
      }
      throw new Error('Invalid CoinSwitch response structure');
    } catch (err) {
      // Mock orderbook fallback
      try {
        const ticker = await this.fetchTicker(symbol);
        const mid = ticker.last || 1.0;
        const bids = [];
        const asks = [];
        for (let i = 1; i <= 5; i++) {
          bids.push([mid * (1 - 0.001 * i), 10 / i]);
          asks.push([mid * (1 + 0.001 * i), 10 / i]);
        }
        return { bids, asks };
      } catch (tickerErr) {
        return { bids: [[1, 10]], asks: [[1.01, 10]] };
      }
    }
  }

  // Private API: fetchBalance (Simulated or Live)
  async fetchBalance() {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return { USDT: { free: 1000, used: 0, total: 1000 } };
    }

    let usdtTotal = 0;
    let usdtFree = 0;

    // 1. Check Futures Wallet Balance (if any USDT is specifically held)
    const auth = await this._signRequest('GET', '/futures/wallet_balance');
    if (auth && !this.isDemo) {
      try {
        const res = await axios.get(`https://coinswitch.co/trade/api/v2/futures/wallet_balance`, auth);
        if (res.data && res.data.data && res.data.data.base_asset_balances) {
          const usdtBal = res.data.data.base_asset_balances.find(b => b.base_asset === 'USDT');
          if (usdtBal && usdtBal.balances) {
            const b = usdtBal.balances;
            usdtTotal = parseFloat(b.total_balance || 0);
            usdtFree = parseFloat(b.total_available_balance || 0);
          }
        }
      } catch (err) {
        logger.error(`CoinSwitch fetchBalance live error: ${err.message}`);
      }
    }

    // 2. Check Spot Portfolio for INR and convert it to USDT equivalent (since CoinSwitch Pro automatically converts INR for futures margin)
    const spotAuth = await this._signRequest('GET', '/user/portfolio');
    if (spotAuth && !this.isDemo) {
      try {
        const res = await axios.get(`https://coinswitch.co/trade/api/v2/user/portfolio`, spotAuth);
        if (res.data && res.data.data) {
          const inrBal = res.data.data.find(item => item.currency === 'INR' || item.name === 'Indian Rupee' || item.asset === 'INR');
          if (inrBal) {
            const rawInr = parseFloat(inrBal.main_balance || inrBal.available_balance || 0);
            if (rawInr > 0) {
              // Convert INR to USDT using a stable exchange premium rate
              const inrRate = 96.56;
              const convertedUsdt = rawInr / inrRate;
              usdtTotal += convertedUsdt;
              usdtFree += convertedUsdt;
            }
          }
        }
      } catch (err) {
        logger.error(`CoinSwitch fetchBalance spot INR error: ${err.message}`);
      }
    }

    if (usdtTotal > 0) {
      return {
        USDT: {
          free: usdtFree,
          used: usdtTotal - usdtFree,
          total: usdtTotal
        }
      };
    }

    // Default Fallback: Return database fields
    return {
      USDT: {
        free: portfolio.availableBalance,
        used: portfolio.totalBalance - portfolio.availableBalance,
        total: portfolio.totalBalance
      }
    };
  }

  // Private API: createMarketOrder (Simulated or Live)
  async createMarketOrder(symbol, side, amount) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    const ticker = await this.fetchTicker(symbol);
    const price = ticker.last || 1.0;

    const body = {
      exchange: 'EXCHANGE_2',
      symbol: cleanSym,
      side: side.toUpperCase(),
      order_type: 'MARKET',
      quantity: parseFloat(amount)
    };

    const auth = await this._signRequest('POST', '/futures/order', body);
    if (auth && !this.isDemo) {
      try {
        try {
          await this.ensureLeverage(symbol, parseInt(process.env.DEFAULT_LEVERAGE) || 3);
        } catch (levErr) {
          logger.warn(`Non-blocking leverage setup warning for ${symbol}: ${levErr.message}`);
        }
        const res = await axios.post(`https://coinswitch.co/trade/api/v2/futures/order`, body, auth);
        if (res.data && res.data.data) {
          const o = res.data.data;
          return {
            id: o.order_id || o.orderId,
            symbol: symbol,
            type: 'market',
            side: side,
            price: parseFloat(o.averagePrice || o.price || price),
            amount: parseFloat(o.quantity),
            filled: parseFloat(o.quantity),
            status: 'closed',
            fee: { cost: o.fee ? parseFloat(o.fee) / 83.5 : amount * price * 0.0005, currency: 'USDT' }
          };
        }
      } catch (err) {
        logger.error(`CoinSwitch createMarketOrder live error: ${err.message}`);
        throw err;
      }
    }

    // Paper-trading simulation
    return {
      id: 'sim_' + Math.random().toString(36).substr(2, 9),
      symbol: symbol,
      type: 'market',
      side: side,
      price: price,
      amount: parseFloat(amount),
      filled: parseFloat(amount),
      status: 'closed',
      fee: { cost: amount * price * 0.0005, currency: 'USDT' }
    };
  }

  // Private API: createLimitOrder (Simulated or Live)
  async createLimitOrder(symbol, side, amount, price) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    const body = {
      exchange: 'EXCHANGE_2',
      symbol: cleanSym,
      side: side.toUpperCase(),
      order_type: 'LIMIT',
      quantity: parseFloat(amount),
      price: parseFloat(price)
    };

    const auth = await this._signRequest('POST', '/futures/order', body);
    if (auth && !this.isDemo) {
      try {
        try {
          await this.ensureLeverage(symbol, parseInt(process.env.DEFAULT_LEVERAGE) || 3);
        } catch (levErr) {
          logger.warn(`Non-blocking leverage setup warning for ${symbol}: ${levErr.message}`);
        }
        const res = await axios.post(`https://coinswitch.co/trade/api/v2/futures/order`, body, auth);
        if (res.data && res.data.data) {
          const o = res.data.data;
          return {
            id: o.order_id || o.orderId,
            symbol: symbol,
            type: 'limit',
            side: side,
            price: parseFloat(o.price || price),
            amount: parseFloat(o.quantity),
            filled: 0,
            status: 'open',
            fee: { cost: 0, currency: 'USDT' }
          };
        }
      } catch (err) {
        const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.error(`CoinSwitch createLimitOrder live error: ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }

    // Paper-trading simulation
    return {
      id: 'sim_' + Math.random().toString(36).substr(2, 9),
      symbol: symbol,
      type: 'limit',
      side: side,
      price: price,
      amount: parseFloat(amount),
      filled: 0,
      status: 'open',
      fee: { cost: 0, currency: 'USDT' }
    };
  }

  // Private API: createOrder (Simulated or Live)
  async createOrder(symbol, type, side, amount, price, params = {}) {
    if (this.isDemo) {
      const stopPrice = params.stopPrice || params.triggerPrice;
      return {
        id: 'sim_trigger_' + Math.random().toString(36).substr(2, 9),
        symbol,
        type,
        side,
        price,
        amount,
        status: 'open',
        stopPrice
      };
    }

    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    const rawStop = params.stopPrice !== undefined && params.stopPrice !== null ? params.stopPrice : (params.triggerPrice !== undefined && params.triggerPrice !== null ? params.triggerPrice : params.trigger_price);
    const stopPrice = (rawStop !== undefined && rawStop !== null && !isNaN(parseFloat(rawStop)) && parseFloat(rawStop) > 0) ? parseFloat(rawStop) : undefined;
    const reduceOnly = params.reduceOnly || params.reduce_only;

    // Map order type (e.g. 'stop_market' -> 'STOP_MARKET')
    let orderType = type.toUpperCase();
    if (orderType === 'STOP') orderType = 'STOP_MARKET';
    if (orderType === 'TAKE_PROFIT') orderType = 'TAKE_PROFIT_MARKET';

    let qty = parseFloat(amount || 0);
    const isTriggerOrder = orderType === 'STOP_MARKET' || orderType === 'TAKE_PROFIT_MARKET';
    if (isTriggerOrder) {
      qty = 0;
    }

    // Validate trigger_price for trigger orders BEFORE sending to the exchange
    if (isTriggerOrder && (stopPrice === undefined || stopPrice === null || isNaN(parseFloat(stopPrice)) || parseFloat(stopPrice) <= 0)) {
      throw new Error(`Invalid trigger_price (${stopPrice}) for ${orderType} order on ${symbol}. A valid positive trigger price is required.`);
    }

    const body = {
      exchange: 'EXCHANGE_2',
      symbol: cleanSym,
      side: side.toUpperCase(),
      order_type: orderType,
      quantity: qty
    };

    if (price !== undefined && price !== null) {
      body.price = parseFloat(price);
    }

    if (stopPrice !== undefined && stopPrice !== null) {
      body.trigger_price = parseFloat(stopPrice);
    }

    if (isTriggerOrder) {
      body.reduce_only = true;
      body.close_position = true;
    } else if (reduceOnly !== undefined) {
      body.reduce_only = reduceOnly === true || reduceOnly === 'true';
    }

    const path = '/futures/order';
    try {
      if (!this.isDemo) {
        try {
          await this.ensureLeverage(symbol, parseInt(process.env.DEFAULT_LEVERAGE) || 3);
        } catch (levErr) {
          logger.warn(`Non-blocking leverage setup warning for ${symbol}: ${levErr.message}`);
        }
      }
      const res = await this._requestWithRetry('POST', path, body);
      if (res.data && res.data.data) {
        const o = res.data.data;
        return {
          id: o.order_id || o.orderId,
          symbol,
          type,
          side,
          price: price || o.price || 0,
          amount: amount,
          status: 'open',
          raw: o
        };
      }
    } catch (err) {
      const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`CoinSwitch createOrder live error: ${errorDetail}`);
      throw new Error(errorDetail);
    }
    throw new Error(`Failed to place live order on CoinSwitch Pro for ${symbol}`);
  }

  // Private API: fetchPositions (Simulated or Live)
  async fetchPositions(symbol) {
    const now = Date.now();
    const cacheKey = symbol || 'ALL';
    if (this.positionsCache[cacheKey] && (now - this.positionsCache[cacheKey].timestamp < 3000)) {
      return this.positionsCache[cacheKey].data;
    }

    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return [];
    }

    if (!this.isDemo) {
      try {
        const path = symbol
          ? `/futures/positions?exchange=EXCHANGE_2&symbol=${symbol.replace('/', '').replace(':USDT', '').toUpperCase()}`
          : `/futures/positions?exchange=EXCHANGE_2`;
          
        const res = await this._requestWithRetry('GET', path);
        if (res) {
          if (res.data) {
            if (res.data.message && res.data.message.includes('no open Positions')) {
              this.positionsCache[cacheKey] = { timestamp: now, data: [] };
              return [];
            }
            if (res.data.data) {
              const rawData = res.data.data.positions || res.data.data.orders || res.data.data;
              const data = Array.isArray(rawData) ? rawData : [rawData];
              const result = data.filter(p => p && (p.symbol || p.asset)).map(p => ({
                symbol: (p.symbol || p.asset || '').replace('/', '').replace(':USDT', '').toUpperCase(),
                contracts: parseFloat(p.quantity || p.position_size || p.positionSize || p.contracts || 0),
                side: (p.side || p.position_side || p.positionSide || 'LONG').toLowerCase(),
                entryPrice: parseFloat(p.entryPrice || p.avg_entry_price || p.avgEntryPrice || p.entry_price || 0),
                markPrice: parseFloat(p.mark_price || p.markPrice || p.currentPrice || p.entryPrice || 0),
                unrealizedPnl: parseFloat(p.unrealised_pnl || p.unrealizedPnl || 0),
                leverage: parseFloat(p.leverage || 5)
              }));
              this.positionsCache[cacheKey] = { timestamp: now, data: result };
              return result;
            }
          }
        }
      } catch (err) {
        if (this.positionsCache[cacheKey]) return this.positionsCache[cacheKey].data;
        logger.error(`CoinSwitch fetchPositions live error: ${err.message}`);
      }
    }

    // Default Fallback: Return open positions from DB
    const dbPositions = portfolio.positions.filter(p => p.status === 'open');
    const result = dbPositions.map(p => ({
      symbol: p.asset,
      contracts: p.quantity,
      side: p.side,
      entryPrice: p.entryPrice,
      markPrice: p.currentPrice || p.entryPrice,
      unrealizedPnl: p.unrealizedPnl || 0,
      leverage: p.leverage || 10
    }));
    this.positionsCache[cacheKey] = { timestamp: now, data: result };
    return result;
  }

  // Private API: fetchOrder (Simulated or Live)
  async fetchOrder(id, symbol) {
    try {
      if (id && id.startsWith('sim_')) {
        const { default: Trade } = await import('../models/Trade.js');
        const trade = await Trade.findOne({ exchangeOrderId: id });
        if (trade) {
          return { id, symbol, status: 'closed', filled: trade.quantity, amount: trade.quantity };
        }
        return { id, symbol, status: 'closed', filled: 1.0, amount: 1.0 };
      }

      if (!this.isDemo) {
        // Live implementation
        const path = `/futures/order?order_id=${id}`;
        const res = await this._requestWithRetry('GET', path);
        if (res && res.data && res.data.data) {
          const o = res.data.data.order || res.data.data;
          
          let status = 'open';
          if (o.status === 'EXECUTED' || o.status === 'PARTIALLY_EXECUTED') {
            status = 'closed';
          } else if (o.status === 'CANCELLED') {
            status = 'canceled';
          }

          return {
            id: o.order_id || o.orderId,
            symbol: symbol,
            status: status,
            price: parseFloat(o.avg_execution_price || o.averagePrice || o.price || 0),
            amount: parseFloat(o.quantity || 0),
            filled: parseFloat(o.exec_quantity || o.executedQuantity || o.quantity || 0),
            fee: { cost: parseFloat(o.execution_fee || o.fee || 0) / 83.5, currency: 'USDT' }
          };
        } else {
          throw new Error(`Order ${id} not found or invalid response from exchange`);
        }
      }
    } catch (err) {
      logger.error(`CoinSwitch fetchOrder live error: ${err.message}`);
      if (!this.isDemo) {
        throw err;
      }
    }
    // Default simulated fallback for demo/sim orders
    return { id, symbol, status: 'closed', filled: 1.0, amount: 1.0 };
  }

  // Private API: cancelOrder (Simulated or Live)
  async cancelOrder(id, symbol) {
    try {
      if (id && id.startsWith('sim_')) {
        return { id, symbol, status: 'canceled' };
      }

      // Live implementation
      const body = {
        exchange: 'EXCHANGE_2',
        order_id: id
      };
      const path = '/futures/order';
      if (!this.isDemo) {
        const res = await this._requestWithRetry('DELETE', path, body);
        if (res && res.data && res.data.data) {
          return { id, symbol, status: 'canceled', raw: res.data.data };
        }
      }
    } catch (err) {
      logger.error(`CoinSwitch cancelOrder live error: ${err.message}`);
    }
    return { id, symbol, status: 'canceled' };
  }

  // Private API: cancelAllOrders (Simulated or Live)
  async cancelAllOrders(symbol) {
    try {
      if (!symbol || symbol.startsWith('sim_')) {
        return { symbol, status: 'all_canceled' };
      }

      // Live implementation
      const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
      const path = '/futures/cancel_all';
      const body = {
        exchange: 'EXCHANGE_2',
        symbol: cleanSym
      };
      if (!this.isDemo) {
        const res = await this._requestWithRetry('POST', path, body);
        if (res && res.data && res.data.data) {
          return { symbol, status: 'all_canceled', raw: res.data.data };
        }
      }
    } catch (err) {
      logger.error(`CoinSwitch cancelAllOrders live error: ${err.message}`);
    }
    return { symbol, status: 'all_canceled' };
  }

  // Private API: fetchMyTrades (Simulated or Live)
  async fetchMyTrades(symbol, since, limit, params = {}) {
    return [];
  }

  // Private API: fetchOpenOrders (Simulated or Live)
  async fetchOpenOrders(symbol, since, limit, params = {}) {
    try {
      if (this.isDemo) {
        return [];
      }

      const cleanSym = symbol ? symbol.replace('/', '').replace(':USDT', '').replace(':USDT', '').toUpperCase() : undefined;
      const path = '/futures/orders/open';
      const body = {
        exchange: 'EXCHANGE_2'
      };
      if (cleanSym) {
        body.symbol = cleanSym;
      }
      if (limit) {
        body.limit = limit;
      }

      {
        const res = await this._requestWithRetry('POST', path, body);
        if (res.data && res.data.data && res.data.data.orders) {
          const orders = res.data.data.orders;
          return orders.map(o => {
            let status = 'open';
            if (o.status === 'EXECUTED' || o.status === 'PARTIALLY_EXECUTED') {
              status = 'closed';
            } else if (o.status === 'CANCELLED') {
              status = 'canceled';
            }
            return {
              id: o.order_id || o.orderId,
              symbol: symbol || o.symbol,
              type: (o.order_type || 'LIMIT').toLowerCase(),
              side: (o.side || 'BUY').toLowerCase(),
              status: status,
              price: parseFloat(o.avg_execution_price || o.averagePrice || o.price || 0),
              amount: parseFloat(o.quantity || 0),
              filled: parseFloat(o.exec_quantity || o.executedQuantity || 0),
              stopPrice: parseFloat(o.trigger_price || 0),
              reduceOnly: o.reduce_only === true,
              raw: o
            };
          });
        }
      }
    } catch (err) {
      logger.error(`CoinSwitch fetchOpenOrders live error: ${err.message}`);
    }
    return [];
  }

  // Private API: fetchClosedOrders (Simulated or Live)
  async fetchClosedOrders(symbol, since, limit, params = {}) {
    try {
      if (this.isDemo) {
        return [];
      }

      const cleanSym = symbol ? symbol.replace('/', '').replace(':USDT', '').replace(':USDT', '').toUpperCase() : undefined;
      const path = '/futures/orders/closed';
      const body = {
        exchange: 'EXCHANGE_2'
      };
      if (cleanSym) {
        body.symbol = cleanSym;
      }
      if (limit) {
        body.limit = limit;
      }
      if (since) {
        body.from_time = since;
      }

      {
        const res = await this._requestWithRetry('POST', path, body);
        if (res.data && res.data.data && res.data.data.orders) {
          const orders = res.data.data.orders;
          return orders.map(o => {
            let status = 'open';
            if (o.status === 'EXECUTED' || o.status === 'PARTIALLY_EXECUTED') {
              status = 'closed';
            } else if (o.status === 'CANCELLED') {
              status = 'canceled';
            }
            return {
              id: o.order_id || o.orderId,
              symbol: symbol || o.symbol,
              type: (o.order_type || 'LIMIT').toLowerCase(),
              side: (o.side || 'BUY').toLowerCase(),
              status: status,
              price: parseFloat(o.avg_execution_price || o.averagePrice || o.price || 0),
              amount: parseFloat(o.quantity || 0),
              filled: parseFloat(o.exec_quantity || o.executedQuantity || 0),
              stopPrice: parseFloat(o.trigger_price || 0),
              reduceOnly: o.reduce_only === true,
              realisedPnl: parseFloat(o.realised_pnl || 0),
              executionFee: parseFloat(o.execution_fee || 0),
              timestamp: o.updated_at || o.created_at,
              raw: o
            };
          });
        }
      }
    } catch (err) {
      logger.error(`CoinSwitch fetchClosedOrders live error: ${err.message}`);
    }
    return [];
  }

  // Private API: Set leverage for a futures contract
  async setLeverage(symbol, leverage = 3) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    const body = {
      exchange: 'EXCHANGE_2',
      symbol: cleanSym,
      leverage: parseInt(leverage)
    };

    const path = '/futures/leverage';
    if (!this.isDemo) {
      try {
        const res = await this._requestWithRetry('POST', path, body);
        logger.info(`✅ Leverage set to ${leverage}x for ${cleanSym}`);
        return res.data;
      } catch (err) {
        logger.warn(`CoinSwitch setLeverage warning for ${cleanSym}: ${err.response?.data?.message || err.message}`);
        throw err;
      }
    }
    return { simulated: true, leverage };
  }

  // Idempotent leverage setter — only calls the API if leverage hasn't been set for this symbol yet
  async ensureLeverage(symbol, leverage = 3) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
    const cached = this.leverageCache.get(cleanSym);
    if (cached === leverage) return; // already set or attempted this session

    try {
      await this.setLeverage(symbol, leverage);
    } catch (err) {
      // Ignore leverage failure if open orders/positions already exist on exchange
    } finally {
      this.leverageCache.set(cleanSym, leverage);
    }
  }
}

let exchangeInstance = null;

export const getExchange = () => {
  if (!exchangeInstance) {
    exchangeInstance = new CoinSwitchExchange();
    const isDemo = process.env.TRADING_MODE !== 'live';
    exchangeInstance.enableDemoTrading(isDemo);
  }
  return exchangeInstance;
};

export const fetchCandles = async (symbol, timeframe = '5m', limit = 100) => {
  try {
    const exchange = getExchange();
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
      open,
      high,
      low,
      close,
      volume,
      openTime: new Date(timestamp),
      closeTime: new Date(timestamp + 5 * 60 * 1000 - 1),
      isClosed: true,
    }));
  } catch (err) {
    logger.error(`fetchCandles(${symbol}) error: ${err.message}`);
    throw err;
  }
};

export const fetchTicker = async (symbol) => {
  try {
    const exchange = getExchange();
    return await exchange.fetchTicker(symbol);
  } catch (err) {
    logger.error(`fetchTicker(${symbol}) error: ${err.message}`);
    throw err;
  }
};

export const fetchOrderBook = async (symbol, limit = 20) => {
  try {
    const exchange = getExchange();
    return await exchange.fetchOrderBook(symbol, limit);
  } catch (err) {
    logger.error(`fetchOrderBook(${symbol}) error: ${err.message}`);
    throw err;
  }
};

export const placeMarketOrder = async (symbol, side, amount) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    const order = await exchange.createMarketOrder(symbol, side, amount);
    logger.info(`CoinSwitch market order placed: ${side} ${amount} ${symbol} → ID ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`placeMarketOrder(${symbol}, ${side}) error: ${err.message}`);
    throw err;
  }
};

export const placeLimitOrder = async (symbol, side, amount, price) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    const order = await exchange.createLimitOrder(symbol, side, amount, price);
    logger.info(`CoinSwitch limit order placed: ${side} ${amount} ${symbol} @ ${price} → ID ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`placeLimitOrder(${symbol}, ${side}) error: ${err.message}`);
    throw err;
  }
};

export const fetchOrder = async (symbol, orderId) => {
  try {
    const exchange = getExchange();
    return await exchange.fetchOrder(orderId, symbol);
  } catch (err) {
    logger.error(`fetchOrder(${orderId}, ${symbol}) error: ${err.message}`);
    throw err;
  }
};

export const cancelOrder = async (symbol, orderId, params = {}) => {
  try {
    const exchange = getExchange();
    return await exchange.cancelOrder(orderId, symbol);
  } catch (err) {
    logger.error(`cancelOrder(${orderId}, ${symbol}) error: ${err.message}`);
    throw err;
  }
};

export const cancelAllOrders = async (symbol) => {
  try {
    const exchange = getExchange();
    return await exchange.cancelAllOrders(symbol);
  } catch (err) {
    logger.error(`cancelAllOrders(${symbol}) error: ${err.message}`);
    throw err;
  }
};

export const fetchBalance = async () => {
  try {
    const exchange = getExchange();
    return await exchange.fetchBalance();
  } catch (err) {
    logger.error(`fetchBalance error: ${err.message}`);
    throw err;
  }
};

export const fetchPositions = async (symbol) => {
  try {
    const exchange = getExchange();
    const positions = await exchange.fetchPositions();
    if (symbol) {
      return positions.filter(p => p.symbol === symbol);
    }
    return positions;
  } catch (err) {
    logger.error(`fetchPositions error: ${err.message}`);
    throw err;
  }
};

export const checkAssetLiquidity = async (symbol, side) => {
  try {
    const exchange = getExchange();
    const orderBook = await exchange.fetchOrderBook(symbol, 5);
    const ticker = await exchange.fetchTicker(symbol);
    const markPrice = ticker.last || ticker.markPrice || 0;

    if (markPrice <= 0) return false;

    if (side === 'long' || side === 'sell') {
      if (!orderBook.bids || orderBook.bids.length === 0 || orderBook.bids[0][1] <= 0.001) {
        return false;
      }
      const bestBid = orderBook.bids[0][0];
      if (Math.abs(bestBid - markPrice) / markPrice > 0.09) {
        return false;
      }
    } else {
      if (!orderBook.asks || orderBook.asks.length === 0 || orderBook.asks[0][1] <= 0.001) {
        return false;
      }
      const bestAsk = orderBook.asks[0][0];
      if (Math.abs(bestAsk - markPrice) / markPrice > 0.09) {
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.warn(`⚠️ [LIQUIDITY CHECK FAILED] Failed to check liquidity for ${symbol}: ${err.message}. Assuming no liquidity.`);
    return false;
  }
};

export const fetchAllTickers = async () => {
  try {
    const exchange = getExchange();
    return await exchange.fetchAllTickers();
  } catch (err) {
    logger.error(`fetchAllTickers error: ${err.message}`);
    throw err;
  }
};

export const setLeverage = async (symbol, leverage) => {
  try {
    const exchange = getExchange();
    return await exchange.ensureLeverage(symbol, leverage);
  } catch (err) {
    logger.error(`setLeverage(${symbol}, ${leverage}) error: ${err.message}`);
    throw err;
  }
};

export default {
  getExchange,
  fetchCandles,
  fetchTicker,
  fetchAllTickers,
  fetchOrderBook,
  placeMarketOrder,
  placeLimitOrder,
  fetchOrder,
  cancelOrder,
  cancelAllOrders,
  fetchBalance,
  fetchPositions,
  checkAssetLiquidity,
  setLeverage,
};
