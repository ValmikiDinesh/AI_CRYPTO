import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();
  const symbol = 'DOT/USDT:USDT';
  const market = exchange.market(symbol);
  console.log("Market filters for DOTUSDT:");
  console.log(JSON.stringify(market.info.filters, null, 2));
}

run().catch(console.error);
