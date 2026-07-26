import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();
  
  const ticker = await exchange.fetchTicker('1000PEPE/USDT:USDT');
  console.log("Ticker for 1000PEPE:", JSON.stringify(ticker, null, 2));

  const openOrders = await exchange.fetchOpenOrders('1000PEPE/USDT:USDT');
  console.log(`Open orders on Binance for 1000PEPE: ${openOrders.length}`);
  openOrders.forEach(o => {
    console.log(`- ID: ${o.id}, Symbol: ${o.symbol}, Type: ${o.type}, Side: ${o.side}, Qty: ${o.amount}, Price: ${o.price}, stopPrice: ${o.stopPrice || o.triggerPrice}, Status: ${o.status}`);
  });
}

run().catch(console.error);
