import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();

  const symbols = ['ADA/USDT:USDT', 'SOL/USDT:USDT', '1000BONK/USDT:USDT'];

  for (const symbol of symbols) {
    console.log(`=== Fetching open orders for ${symbol} ===`);
    try {
      const openOrders = await exchange.fetchOpenOrders(symbol);
      console.log(`Found ${openOrders.length} open order(s) for ${symbol}:`);
      openOrders.forEach(o => {
        console.log(` - ID: ${o.id} | Type: ${o.type} | Side: ${o.side} | Qty: ${o.amount} | Price: ${o.price} | StopPrice: ${o.stopPrice}`);
      });
    } catch (err) {
      console.error(`Error fetching orders for ${symbol}:`, err.message);
    }
  }
}

run().catch(console.error);
