import ccxt from 'ccxt';
import 'dotenv/config';

async function run() {
  const exchangeConfig = {
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    secret: process.env.BINANCE_TESTNET_API_SECRET,
    enableRateLimit: true,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    },
  };

  if (process.env.BINANCE_PROXY) {
    exchangeConfig.httpProxy = process.env.BINANCE_PROXY;
    console.log(`Using proxy: ${process.env.BINANCE_PROXY}`);
  }

  // Create default exchange (live Binance)
  const exchangeLive = new ccxt.binance({
    enableRateLimit: true,
    options: {
      defaultType: 'future'
    },
    httpProxy: process.env.BINANCE_PROXY
  });
  
  console.log('Loading markets for live Binance futures...');
  try {
    const markets = await exchangeLive.loadMarkets();
    const keys = Object.keys(markets);
    console.log(`Successfully loaded ${keys.length} markets!`);
    console.log('Sample keys:', keys.slice(0, 10));
    
    // Look for ETHUSDT or ETH/USDT:USDT
    const ethMatches = keys.filter(s => s.toLowerCase().includes('eth'));
    console.log('ETH matches:', ethMatches.slice(0, 10));
  } catch (err) {
    console.error('Failed to load markets:', err.message);
  }
}

run().catch(console.error);
