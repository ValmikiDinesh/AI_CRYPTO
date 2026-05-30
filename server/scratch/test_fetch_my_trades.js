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
  
  console.log('Fetching my trades for ETH/USDT:USDT...');
  try {
    const trades = await exchange.fetchMyTrades('ETH/USDT:USDT', undefined, 20);
    console.log(`Successfully fetched ${trades.length} trades!`);
    for (const t of trades) {
      console.log(`ID: ${t.id} | Order: ${t.order} | Symbol: ${t.symbol} | Side: ${t.side} | Price: ${t.price} | Qty: ${t.amount} | Time: ${new Date(t.timestamp).toLocaleString()}`);
    }
  } catch (err) {
    console.error('Fetch my trades failed:', err.message);
  }
}

run().catch(console.error);
