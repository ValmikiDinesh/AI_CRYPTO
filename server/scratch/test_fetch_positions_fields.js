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
  
  console.log('Fetching positions...');
  try {
    const positions = await exchange.fetchPositions(['ETH/USDT:USDT']);
    console.log(`Success! Fetched ${positions.length} positions.`);
    if (positions.length > 0) {
      console.log('Sample position structure:');
      console.log(JSON.stringify(positions[0], null, 2));
    } else {
      console.log('No positions returned.');
    }
  } catch (err) {
    console.error('Fetch positions failed:', err);
  }
}

run().catch(console.error);
