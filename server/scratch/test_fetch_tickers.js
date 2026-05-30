import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  console.log('Fetching tickers...');
  const tickers = await exchange.fetchTickers();
  const keys = Object.keys(tickers);
  console.log('Total tickers fetched:', keys.length);
  if (keys.length > 0) {
    const firstKey = keys[0];
    console.log(`Sample ticker [${firstKey}]:`, JSON.stringify(tickers[firstKey], null, 2));
  }
}

run().catch(console.error);
