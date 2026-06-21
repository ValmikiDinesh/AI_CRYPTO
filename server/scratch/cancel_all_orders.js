import { getExchange } from '../services/exchangeService.js';
import { SUPPORTED_ASSETS } from '../config/constants.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();
  console.log("Cancelling all open orders and trigger orders for all supported assets...");

  for (const asset of SUPPORTED_ASSETS) {
    try {
      const symbol = `${asset.replace('USDT', '')}/USDT:USDT`;
      console.log(`Checking/cancelling orders for ${symbol}...`);
      await exchange.cancelAllOrders(symbol);
      console.log(`✅ Cancelled all open orders/triggers for ${symbol}`);
    } catch (err) {
      console.log(`Skipped or no orders for ${asset}: ${err.message}`);
    }
  }

  console.log("Cleanup completed!");
}

run().catch(console.error);
