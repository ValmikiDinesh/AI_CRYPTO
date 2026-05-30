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
  
  const symbol = 'ETH/USDT:USDT';
  const amount = 0.01;
  
  console.log(`1. Placing BUY market order for ${amount} ${symbol}...`);
  try {
    const buyOrder = await exchange.createMarketOrder(symbol, 'buy', amount);
    console.log(`BUY Order placed successfully! ID: ${buyOrder.id}`);
    
    console.log("2. Fetching positions using ['ETHUSDT'] (raw symbol)...");
    const positionsRaw = await exchange.fetchPositions(['ETHUSDT']);
    console.log(`Fetched ${positionsRaw.length} positions using raw symbol.`);
    if (positionsRaw.length > 0) {
      console.log('Returned position details (raw):', JSON.stringify(positionsRaw[0], null, 2));
    }
    
    console.log("3. Fetching positions using ['ETH/USDT:USDT'] (unified symbol)...");
    const positionsUnified = await exchange.fetchPositions(['ETH/USDT:USDT']);
    console.log(`Fetched ${positionsUnified.length} positions using unified symbol.`);
    if (positionsUnified.length > 0) {
      console.log('Returned position details (unified):', JSON.stringify(positionsUnified[0], null, 2));
    }
    
    // Close the position
    console.log(`4. Placing offsetting SELL market order for ${amount} ${symbol}...`);
    const sellOrder = await exchange.createMarketOrder(symbol, 'sell', amount);
    console.log(`SELL Order placed successfully! ID: ${sellOrder.id}`);
  } catch (err) {
    console.error('Test failed:', err);
  }
}

run().catch(console.error);
