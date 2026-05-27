import ccxt from 'ccxt';
import { logger } from '../utils/logger.js';

let exchangeInstance = null;

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
    return await exchange.fetchTicker(symbol);
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
    const order = await exchange.createMarketOrder(symbol, side, amount);
    logger.info(`Order placed: ${side} ${amount} ${symbol} → ID ${order.id}`);
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
    const order = await exchange.createLimitOrder(symbol, side, amount, price);
    logger.info(`Limit order: ${side} ${amount} ${symbol} @ ${price} → ID ${order.id}`);
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
    return await exchange.fetchBalance();
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
    const exchange = getExchange();
    const positions = await exchange.fetchPositions(symbol ? [symbol] : undefined);
    return positions.filter((p) => parseFloat(p.contracts) > 0);
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
