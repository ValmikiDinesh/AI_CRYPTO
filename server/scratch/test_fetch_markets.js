import ccxt from 'ccxt';
import 'dotenv/config';

async function run() {
  console.log('1. Calling fetchMarkets() WITHOUT proxy...');
  const exchangeNoProxy = new ccxt.binance({
    enableRateLimit: true,
    options: {
      defaultType: 'future'
    }
  });
  
  try {
    const markets = await exchangeNoProxy.fetchMarkets();
    console.log(`fetchMarkets without proxy returned ${markets.length} items.`);
  } catch (err) {
    console.error('fetchMarkets without proxy failed:', err.message);
  }

  console.log('\n2. Calling fetchMarkets() WITH proxy...');
  const exchangeWithProxy = new ccxt.binance({
    enableRateLimit: true,
    options: {
      defaultType: 'future'
    },
    httpProxy: process.env.BINANCE_PROXY
  });
  
  try {
    const markets = await exchangeWithProxy.fetchMarkets();
    console.log(`fetchMarkets with proxy returned ${markets.length} items.`);
  } catch (err) {
    console.error('fetchMarkets with proxy failed:', err.message);
  }
}

run().catch(console.error);
