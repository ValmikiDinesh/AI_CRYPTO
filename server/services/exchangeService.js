import ccxt from 'ccxt';
import { logger } from '../utils/logger.js';

let exchangeInstance = null;

/**
 * Helper to retry asynchronous operations when Binance Demo server glitches.
 */
const retry = async (fn, retries = 8, delayMs = 2000) => {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      logger.warn(`Binance API temporary failure (attempt ${i}/${retries}): ${err.message}. Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

/**
 * Get or create Binance Futures Testnet exchange instance via CCXT.
 */
export const getExchange = () => {
  if (exchangeInstance) return exchangeInstance;

  const exchangeConfig = {
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    secret: process.env.BINANCE_TESTNET_API_SECRET,
    enableRateLimit: true,
    options: {
      defaultType: 'future',  // futures trading
      adjustForTimeDifference: true,
    },
  };

  if (process.env.BINANCE_PROXY) {
    exchangeConfig.httpProxy = process.env.BINANCE_PROXY;
    logger.info(`Routing CCXT traffic through proxy: ${process.env.BINANCE_PROXY}`);
  }

  logger.info(`Initializing CCXT Binance exchange with API Key: ${process.env.BINANCE_TESTNET_API_KEY ? process.env.BINANCE_TESTNET_API_KEY.substring(0, 6) + '...' : 'undefined'}`);

  exchangeInstance = new ccxt.binance(exchangeConfig);

  // Enable newer Binance Demo Trading mode since old testnet/sandbox is deprecated for futures
  exchangeInstance.enableDemoTrading(true);

  logger.info('CCXT Binance Futures Demo Trading exchange initialized');
  return exchangeInstance;
};

/**
 * Fetch OHLCV candles for a symbol.
 */
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

/**
 * Fetch current ticker (last price, bid, ask, volume).
 */
export const fetchTicker = async (symbol) => {
  try {
    const exchange = getExchange();
    return await retry(() => exchange.fetchTicker(symbol));
  } catch (err) {
    logger.error(`fetchTicker(${symbol}) error: ${err.message}`);
    throw err;
  }
};

/**
 * Fetch order book.
 */
export const fetchOrderBook = async (symbol, limit = 20) => {
  try {
    const exchange = getExchange();
    return await exchange.fetchOrderBook(symbol, limit);
  } catch (err) {
    logger.error(`fetchOrderBook(${symbol}) error: ${err.message}`);
    throw err;
  }
};

/**
 * Place a market order (paper trading on testnet).
 */
export const placeMarketOrder = async (symbol, side, amount) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    const formattedAmount = parseFloat(exchange.amountToPrecision(symbol, amount));
    const order = await exchange.createMarketOrder(symbol, side, formattedAmount);
    logger.info(`Order placed: ${side} ${formattedAmount} ${symbol} (raw: ${amount}) → ID ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`placeMarketOrder(${symbol}, ${side}) error: ${err.message}`);
    throw err;
  }
};

/**
 * Place a limit order with stop-loss and take-profit.
 */
export const placeLimitOrder = async (symbol, side, amount, price) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    const formattedAmount = parseFloat(exchange.amountToPrecision(symbol, amount));
    const formattedPrice = parseFloat(exchange.priceToPrecision(symbol, price));
    const order = await exchange.createLimitOrder(symbol, side, formattedAmount, formattedPrice);
    logger.info(`Limit order: ${side} ${formattedAmount} ${symbol} @ ${formattedPrice} (raw: ${amount} @ ${price}) → ID ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`placeLimitOrder error: ${err.message}`);
    throw err;
  }
};

/**
 * Cancel an order.
 */
export const cancelOrder = async (symbol, orderId) => {
  try {
    const exchange = getExchange();
    return await exchange.cancelOrder(orderId, symbol);
  } catch (err) {
    logger.error(`cancelOrder(${orderId}) error: ${err.message}`);
    throw err;
  }
};

/**
 * Fetch account balance.
 */
export const fetchBalance = async () => {
  try {
    const exchange = getExchange();
    return await retry(() => exchange.fetchBalance());
  } catch (err) {
    logger.error(`fetchBalance error: ${err.message}`);
    throw err;
  }
};

/**
 * Fetch open positions.
 */
export const fetchPositions = async (symbol) => {
  try {
    return await retry(async () => {
      const exchange = getExchange();
      
      // Ensure markets are loaded successfully to prevent false empty positions on proxy/network failures
      const markets = await exchange.loadMarkets();
      if (!markets || Object.keys(markets).length === 0) {
        throw new Error('Exchange markets failed to load (possible network issue)');
      }
      
      const positions = await exchange.fetchPositions(symbol ? [symbol] : undefined);
      return positions.filter((p) => parseFloat(p.contracts) > 0);
    });
  } catch (err) {
    logger.error(`fetchPositions error: ${err.message}`);
    throw err;
  }
};

export default {
  getExchange,
  fetchCandles,
  fetchTicker,
  fetchOrderBook,
  placeMarketOrder,
  placeLimitOrder,
  cancelOrder,
  fetchBalance,
  fetchPositions,
};
