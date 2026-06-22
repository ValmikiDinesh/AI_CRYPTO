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
    
    // Resolve unified CCXT symbol if raw asset string is passed (e.g. BONKUSDT -> 1000BONK/USDT:USDT)
    let marketSymbol = symbol;
    if (!symbol.includes('/')) {
      if (symbol.startsWith('1000')) {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      } else if (symbol === 'BONKUSDT' || symbol === 'SHIBUSDT' || symbol === 'PEPEUSDT' || symbol === 'FLOKIUSDT') {
        marketSymbol = '1000' + symbol.replace('USDT', '/USDT:USDT');
      } else {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      }
    }
    
    const market = exchange.market(marketSymbol);
    const marketLotSize = market.info?.filters?.find(f => f.filterType === 'MARKET_LOT_SIZE') || market.info?.filters?.find(f => f.filterType === 'LOT_SIZE');
    const maxQty = marketLotSize ? parseFloat(marketLotSize.maxQty) : null;
    
    if (maxQty && amount > maxQty) {
      logger.info(`⚠️ Market order quantity (${amount}) exceeds max quantity (${maxQty}) for ${marketSymbol}. Splitting into chunks...`);
      let remaining = amount;
      let lastOrder = null;
      let totalFilled = 0;
      let totalCost = 0;
      let totalFee = 0;
      
      while (remaining > 0) {
        const chunk = Math.min(remaining, maxQty);
        const formattedChunk = parseFloat(exchange.amountToPrecision(marketSymbol, chunk));
        if (formattedChunk <= 0) break;
        
        logger.info(`Placing market order chunk: ${side} ${formattedChunk} ${marketSymbol}`);
        const order = await exchange.createMarketOrder(marketSymbol, side, formattedChunk);
        lastOrder = order;
        
        totalFilled += order.filled || formattedChunk;
        totalCost += (order.filled || formattedChunk) * (order.average || order.price || 0);
        if (order.fee && order.fee.cost) {
          totalFee += order.fee.cost;
        }
        
        remaining -= chunk;
      }
      
      // Return aggregated order representation
      return {
        id: lastOrder ? lastOrder.id : 'chunked_order',
        status: 'closed',
        filled: totalFilled,
        amount: amount,
        price: totalFilled > 0 ? (totalCost / totalFilled) : (lastOrder ? lastOrder.price : 0),
        average: totalFilled > 0 ? (totalCost / totalFilled) : (lastOrder ? lastOrder.average : 0),
        fee: {
          cost: totalFee,
          currency: lastOrder?.fee?.currency || 'USDT'
        }
      };
    } else {
      const formattedAmount = parseFloat(exchange.amountToPrecision(marketSymbol, amount));
      const order = await exchange.createMarketOrder(marketSymbol, side, formattedAmount);
      logger.info(`Order placed: ${side} ${formattedAmount} ${marketSymbol} (raw: ${amount}) → ID ${order.id}`);
      return order;
    }
  } catch (err) {
    logger.error(`placeMarketOrder(${symbol}, ${side}) error: ${err.message}`);
    throw err;
  }
};/**
 * Place a limit order with stop-loss and take-profit.
 */
export const placeLimitOrder = async (symbol, side, amount, price) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    
    // Resolve unified CCXT symbol if raw asset string is passed (e.g. BONKUSDT -> 1000BONK/USDT:USDT)
    let marketSymbol = symbol;
    if (!symbol.includes('/')) {
      if (symbol.startsWith('1000')) {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      } else if (symbol === 'BONKUSDT' || symbol === 'SHIBUSDT' || symbol === 'PEPEUSDT' || symbol === 'FLOKIUSDT') {
        marketSymbol = '1000' + symbol.replace('USDT', '/USDT:USDT');
      } else {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      }
    }
    
    const formattedAmount = parseFloat(exchange.amountToPrecision(marketSymbol, amount));
    const formattedPrice = parseFloat(exchange.priceToPrecision(marketSymbol, price));
    const order = await exchange.createLimitOrder(marketSymbol, side, formattedAmount, formattedPrice);
    logger.info(`Limit order placed: ${side} ${formattedAmount} ${marketSymbol} @ ${formattedPrice} (raw: ${amount} @ ${price}) → ID ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`placeLimitOrder(${symbol}, ${side}) error: ${err.message}`);
    throw err;
  }
};

/**
 * Fetch a specific order details.
 */
export const fetchOrder = async (symbol, orderId) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    
    let marketSymbol = symbol;
    if (!symbol.includes('/')) {
      if (symbol.startsWith('1000')) {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      } else if (symbol === 'BONKUSDT' || symbol === 'SHIBUSDT' || symbol === 'PEPEUSDT' || symbol === 'FLOKIUSDT') {
        marketSymbol = '1000' + symbol.replace('USDT', '/USDT:USDT');
      } else {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      }
    }
    
    return await exchange.fetchOrder(orderId, marketSymbol);
  } catch (err) {
    logger.error(`fetchOrder(${orderId}, ${symbol}) error: ${err.message}`);
    throw err;
  }
};

/**
 * Cancel an order.
 */
export const cancelOrder = async (symbol, orderId) => {
  try {
    const exchange = getExchange();
    await exchange.loadMarkets();
    
    let marketSymbol = symbol;
    if (!symbol.includes('/')) {
      if (symbol.startsWith('1000')) {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      } else if (symbol === 'BONKUSDT' || symbol === 'SHIBUSDT' || symbol === 'PEPEUSDT' || symbol === 'FLOKIUSDT') {
        marketSymbol = '1000' + symbol.replace('USDT', '/USDT:USDT');
      } else {
        marketSymbol = symbol.replace('USDT', '/USDT:USDT');
      }
    }
    
    return await exchange.cancelOrder(orderId, marketSymbol);
  } catch (err) {
    logger.error(`cancelOrder(${orderId}, ${symbol}) error: ${err.message}`);
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
      return positions.filter((p) => {
        const contracts = parseFloat(p.contracts) || 0;
        const markPrice = parseFloat(p.markPrice) || parseFloat(p.entryPrice) || 0;
        const positionValue = contracts * markPrice;
        return contracts > 0 && positionValue >= 1.5; // Ignore dust positions worth less than $1.50
      });
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
  fetchOrder,
  cancelOrder,
  fetchBalance,
  fetchPositions,
};
