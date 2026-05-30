import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  console.log('Loading markets...');
  const markets = await exchange.loadMarkets();
  
  const targetSymbols = [
    'PORTAL/USDT:USDT',
    'HEI/USDT:USDT',
    'ID/USDT:USDT',
    'LAB/USDT:USDT',
    'STG/USDT:USDT',
    'EPIC/USDT:USDT'
  ];

  for (const sym of targetSymbols) {
    const m = markets[sym];
    if (m) {
      console.log(`Symbol: ${sym} | Active: ${m.active} | Base: ${m.base} | Quote: ${m.quote} | Id: ${m.id} | Info Symbol: ${m.info.symbol}`);
    } else {
      console.log(`Symbol: ${sym} is NOT found in CCXT markets!`);
    }
  }
}

run().catch(console.error);
