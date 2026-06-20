import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();

  const market = exchange.market('PORTAL/USDT:USDT');
  console.log("=== PORTAL/USDT:USDT MARKET DETAILS ===");
  console.log(JSON.stringify({
    symbol: market.symbol,
    id: market.id,
    precision: market.precision,
    limits: market.limits
  }, null, 2));
}

run().catch(console.error);
