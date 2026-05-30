import ccxt from 'ccxt';
import 'dotenv/config';

async function run() {
  console.log('Initializing CCXT without proxy...');
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    secret: process.env.BINANCE_TESTNET_API_SECRET,
    enableRateLimit: true,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    },
  });
  exchange.enableDemoTrading(true);
  
  console.log('Loading markets...');
  await exchange.loadMarkets();
  
  console.log("1. Fetching positions for ['ETHUSDT'] (raw symbol)...");
  try {
    const positions = await exchange.fetchPositions(['ETHUSDT']);
    console.log(`Success! Fetched ${positions.length} positions.`);
  } catch (err) {
    console.error('FAILED with raw symbol:', err.message);
  }
  
  console.log("2. Fetching positions for ['ETH/USDT:USDT'] (unified symbol)...");
  try {
    const positions = await exchange.fetchPositions(['ETH/USDT:USDT']);
    console.log(`Success! Fetched ${positions.length} positions.`);
  } catch (err) {
    console.error('FAILED with unified symbol:', err.message);
  }
}

run().catch(console.error);
