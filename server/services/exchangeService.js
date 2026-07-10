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
    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    const dec = this.markets[cleanSym]?.precision?.amount || 3;
    return parseFloat(amount).toFixed(dec);
  }

  priceToPrecision(symbol, price) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    const dec = this.markets[cleanSym]?.precision?.price || 2;
    return parseFloat(price).toFixed(dec);
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

  // REST API: Public fetchAllTickers
  async fetchAllTickers() {
    try {
      const res = await axios.get(`${this.baseUrl}/futures/all-pairs/ticker?exchange=EXCHANGE_2`);
      if (res.data && res.data.data) {
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
          return map;
        }
        throw new Error('Invalid Binance response structure');
      } catch (binanceErr) {
        logger.error(`fetchAllTickers fallback error: ${binanceErr.message}`);
        return {};
      }
    }
  }

  // REST API: Public fetchTicker
  async fetchTicker(symbol) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    try {
      // Fetch public ticker from CoinSwitch Futures REST API
      const res = await axios.get(`${this.baseUrl}/futures/ticker?symbol=${cleanSym}`);
      if (res.data && res.data.data) {
        const t = res.data.data;
        return {
          symbol: symbol,
          last: parseFloat(t.lastPrice || t.last || t.close),
          bid: parseFloat(t.bidPrice || t.bid),
          ask: parseFloat(t.askPrice || t.ask),
          high: parseFloat(t.highPrice || t.high),
          low: parseFloat(t.lowPrice || t.low),
          volume: parseFloat(t.volume || t.volume24h),
          markPrice: parseFloat(t.markPrice || t.lastPrice)
        };
      }
      throw new Error('Invalid CoinSwitch response structure');
    } catch (err) {
      // Fallback: Fetch from public Binance Futures API
      try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${cleanSym}`);
        if (res.data) {
          const t = res.data;
          return {
            symbol: symbol,
            last: parseFloat(t.lastPrice),
            bid: parseFloat(t.bidPrice || t.lastPrice * 0.999),
            ask: parseFloat(t.askPrice || t.lastPrice * 1.001),
            high: parseFloat(t.highPrice),
            low: parseFloat(t.lowPrice),
            volume: parseFloat(t.volume),
            markPrice: parseFloat(t.lastPrice)
          };
        }
        throw new Error('Invalid Binance response structure');
      } catch (binanceErr) {
        logger.error(`fetchTicker fallback error for ${symbol}: ${binanceErr.message}`);
        // Return mock placeholder
        return { symbol, last: 60000, bid: 59990, ask: 60010, markPrice: 60000 };
      }
    }
  }

  // REST API: Public fetchOHLCV
  async fetchOHLCV(symbol, timeframe = '5m', since, limit = 100) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    try {
      const res = await axios.get(`${this.baseUrl}/futures/candles?symbol=${cleanSym}&interval=${timeframe}&limit=${limit}`);
      if (res.data && res.data.data) {
        return res.data.data.map(c => [
          new Date(c.time || c.timestamp).getTime(),
          parseFloat(c.open),
          parseFloat(c.high),
          parseFloat(c.low),
          parseFloat(c.close),
          parseFloat(c.volume)
        ]);
      }
      throw new Error('Invalid CoinSwitch response structure');
    } catch (err) {
      // Fallback: Fetch from public Binance Futures API
      try {
        const limitParam = limit || 100;
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSym}&interval=${timeframe}&limit=${limitParam}`);
        if (res.data && Array.isArray(res.data)) {
          return res.data.map(c => [
            parseFloat(c[0]), // openTime
            parseFloat(c[1]), // open
            parseFloat(c[2]), // high
            parseFloat(c[3]), // low
            parseFloat(c[4]), // close
            parseFloat(c[5])  // volume
          ]);
        }
        throw new Error('Invalid Binance response structure');
      } catch (binanceErr) {
        logger.error(`fetchOHLCV fallback error for ${symbol}: ${binanceErr.message}`);
        return [];
      }
    }
  }

  // REST API: Public fetchOrderBook
  async fetchOrderBook(symbol, limit = 20) {
    const cleanSym = symbol.replace('/', '').replace(':USDT', '');
    try {
      const res = await axios.get(`${this.baseUrl}/futures/orderbook?symbol=${cleanSym}&limit=${limit}`);
      if (res.data && res.data.data) {
        return {
          bids: res.data.data.bids.map(b => [parseFloat(b[0]), parseFloat(b[1])]),
          asks: res.data.data.asks.map(a => [parseFloat(a[0]), parseFloat(a[1])])
        };
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

    const auth = await this._signRequest('GET', '/futures/wallet_balance');
    if (auth && !this.isDemo) {
      try {
        const res = await axios.get(`https://coinswitch.co/trade/api/v2/futures/wallet_balance`, auth);
        if (res.data && res.data.data && res.data.data.base_asset_balances) {
          const usdtBal = res.data.data.base_asset_balances.find(b => b.base_asset === 'USDT');
          if (usdtBal && usdtBal.balances) {
            const b = usdtBal.balances;
            const total = parseFloat(b.total_balance || 0);
            const free = parseFloat(b.total_available_balance || 0);
            const used = parseFloat(b.total_blocked_balance || (total - free) || 0);
            return {
              USDT: { free, used, total }
            };
          }
        }
      } catch (err) {
        logger.error(`CoinSwitch fetchBalance live error: ${err.message}`);
      }
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
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
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
        const res = await axios.post(`https://coinswitch.co/trade/api/v2/futures/order`, body, auth);
        if (res.data && res.data.data) {
          const o = res.data.data;
          return {
            id: o.orderId,
            symbol: symbol,
            type: 'market',
            side: side,
            price: parseFloat(o.averagePrice || o.price || price),
            amount: parseFloat(o.quantity),
            filled: parseFloat(o.quantity),
            status: 'closed',
            fee: { cost: parseFloat(o.fee || amount * price * 0.0005), currency: 'USDT' }
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
    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
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
        const res = await axios.post(`https://coinswitch.co/trade/api/v2/futures/order`, body, auth);
        if (res.data && res.data.data) {
          const o = res.data.data;
          return {
            id: o.orderId,
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
        logger.error(`CoinSwitch createLimitOrder live error: ${err.message}`);
        throw err;
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

    const cleanSym = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
    const stopPrice = params.stopPrice || params.triggerPrice || params.trigger_price;
    const reduceOnly = params.reduceOnly || params.reduce_only;

    // Map order type (e.g. 'stop_market' -> 'STOP_MARKET')
    let orderType = type.toUpperCase();
    if (orderType === 'STOP') orderType = 'STOP_MARKET';
    if (orderType === 'TAKE_PROFIT') orderType = 'TAKE_PROFIT_MARKET';

    const body = {
      exchange: 'EXCHANGE_2',
      symbol: cleanSym,
      side: side.toUpperCase(),
      order_type: orderType,
      quantity: parseFloat(amount || 0)
    };

    if (price !== undefined && price !== null) {
      body.price = parseFloat(price);
    }

    if (stopPrice !== undefined && stopPrice !== null) {
      body.trigger_price = parseFloat(stopPrice);
    }

    if (reduceOnly !== undefined) {
      body.reduce_only = reduceOnly === true || reduceOnly === 'true';
    }

    const path = '/futures/order';
    const auth = await this._signRequest('POST', path, body);
    if (auth) {
      try {
        const res = await axios.post(`https://coinswitch.co/trade/api/v2${path}`, body, auth);
        if (res.data && res.data.data) {
          const o = res.data.data;
          return {
            id: o.orderId,
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
        logger.error(`CoinSwitch createOrder live error: ${err.message}`);
        throw err;
      }
    }
    throw new Error(`Failed to place live order on CoinSwitch Pro for ${symbol}`);
  }

  // Private API: fetchPositions (Simulated or Live)
  async fetchPositions(symbol) {
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    if (!portfolio) {
      return [];
    }

    // Helper to query a single symbol on the exchange
    const fetchSingle = async (sym) => {
      const cleanSym = sym.replace('/', '').replace(':USDT', '').toUpperCase();
      const path = `/futures/positions?exchange=EXCHANGE_2&symbol=${cleanSym}`;
      const auth = await this._signRequest('GET', path);
      if (!auth) return null;
      try {
        const res = await axios.get(`https://coinswitch.co/trade/api/v2${path}`, auth);
        if (res.data && res.data.data) {
          const data = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
          return data.map(p => ({
            symbol: p.symbol,
            contracts: parseFloat(p.quantity || p.position_size || p.positionSize || 0),
            side: (p.side || p.position_side || p.positionSide || 'LONG').toLowerCase(),
            entryPrice: parseFloat(p.entryPrice || p.avg_entry_price || p.avgEntryPrice || 0),
            markPrice: parseFloat(p.markPrice || p.currentPrice || p.entryPrice || 0),
            unrealizedPnl: parseFloat(p.unrealizedPnl || p.unrealizedPnl || 0),
            leverage: parseFloat(p.leverage || 0)
          }));
        }
      } catch (err) {
        logger.error(`CoinSwitch fetchPositions live error for ${cleanSym}: ${err.message}`);
      }
      return null;
    };

    if (!this.isDemo) {
      if (symbol) {
        const singlePos = await fetchSingle(symbol);
        if (singlePos) return singlePos;
      } else {
        // Fetch positions for all currently monitored symbols in the database
        const dbOpenAssets = portfolio.positions.filter(p => p.status === 'open').map(p => p.asset);
        // Include core symbols just in case
        const coreAssets = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'DOGEUSDT'];
        const allAssetsToQuery = Array.from(new Set([...dbOpenAssets, ...coreAssets]));
        
        const results = await Promise.all(allAssetsToQuery.map(a => fetchSingle(a)));
        return results.filter(Boolean).flat();
      }
    }

    // Default Fallback: Return open positions from DB
    const dbPositions = portfolio.positions.filter(p => p.status === 'open');
    return dbPositions.map(p => ({
      symbol: p.asset,
      contracts: p.quantity,
      side: p.side,
      entryPrice: p.entryPrice,
      markPrice: p.currentPrice || p.entryPrice,
      unrealizedPnl: p.unrealizedPnl || 0,
      leverage: p.leverage || 10
    }));
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

      // Live implementation
      const path = `/futures/order?order_id=${id}`;
      const auth = await this._signRequest('GET', path);
      if (auth && !this.isDemo) {
        const res = await axios.get(`https://coinswitch.co/trade/api/v2${path}`, auth);
        if (res.data && res.data.data) {
          const o = res.data.data;
          
          let status = 'open';
          if (o.status === 'EXECUTED' || o.status === 'PARTIALLY_EXECUTED') {
            status = 'closed';
          } else if (o.status === 'CANCELLED') {
            status = 'canceled';
          }

          return {
            id: o.orderId,
            symbol: symbol,
            status: status,
            price: parseFloat(o.averagePrice || o.price || 0),
            amount: parseFloat(o.quantity || 0),
            filled: parseFloat(o.executedQuantity || o.quantity || 0),
            fee: { cost: parseFloat(o.fee || 0), currency: 'USDT' }
          };
        }
      }
    } catch (err) {
      logger.error(`CoinSwitch fetchOrder live error: ${err.message}`);
    }
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
      const auth = await this._signRequest('DELETE', path, body);
      if (auth && !this.isDemo) {
        const res = await axios.delete(`https://coinswitch.co/trade/api/v2${path}`, {
          ...auth,
          data: body
        });
        if (res.data && res.data.data) {
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
      const cleanSym = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
      const path = '/futures/cancel_all';
      const body = {
        exchange: 'EXCHANGE_2',
        symbol: cleanSym
      };
      const auth = await this._signRequest('POST', path, body);
      if (auth && !this.isDemo) {
        const res = await axios.post(`https://coinswitch.co/trade/api/v2${path}`, body, auth);
        if (res.data && res.data.data) {
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
    return [];
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
};
