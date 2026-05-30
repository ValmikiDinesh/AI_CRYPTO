import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  console.log('Fetching OHLCV for ETHUSDT...');
  try {
    const ohlcv = await exchange.fetchOHLCV('ETHUSDT', '5m', undefined, 5);
    console.log('OHLCV fetched successfully! Sample:', ohlcv[0]);
  } catch (err) {
    console.error('OHLCV fetch failed:', err.message);
  }
  
  console.log('\nLoading markets again...');
  const markets = await exchange.loadMarkets();
  console.log('Markets keys count:', Object.keys(markets).length);
  if (Object.keys(markets).length > 0) {
    console.log('Sample market keys:', Object.keys(markets).slice(0, 5));
  }
}

run().catch(console.error);
