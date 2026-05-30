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

  const exchange = new ccxt.binance(exchangeConfig);
  exchange.setSandboxMode(true); // Let's check sandbox mode
  
  console.log('Exchange URLs:', exchange.urls);
  
  try {
    console.log('Loading markets with setSandboxMode(true)...');
    const markets = await exchange.loadMarkets();
    console.log('Markets loaded with setSandboxMode:', Object.keys(markets).length);
  } catch (err) {
    console.error('Error with setSandboxMode:', err.message);
  }

  const exchangeDemo = new ccxt.binance(exchangeConfig);
  exchangeDemo.enableDemoTrading(true);
  try {
    console.log('Loading markets with enableDemoTrading(true)...');
    const markets = await exchangeDemo.loadMarkets();
    console.log('Markets loaded with enableDemoTrading:', Object.keys(markets).length);
  } catch (err) {
    console.error('Error with enableDemoTrading:', err.message);
  }
}

run().catch(console.error);
