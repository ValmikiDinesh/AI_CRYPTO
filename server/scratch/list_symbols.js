import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  console.log('Loading markets...');
  const markets = await exchange.loadMarkets();
  const symbols = Object.keys(markets);
  console.log('Total symbols loaded:', symbols.length);
  
  const ethSymbols = symbols.filter(s => s.toLowerCase().includes('eth'));
  console.log('ETH symbols:', ethSymbols.slice(0, 10));
  
  if (markets['ETHUSDT']) {
    console.log('ETHUSDT market details:', JSON.stringify(markets['ETHUSDT'], null, 2));
  } else {
    console.log('ETHUSDT NOT found in markets');
  }
  
  const matches = symbols.filter(s => s.replace('/', '').replace(':', '') === 'ETHUSDT');
  console.log('Matches for clean ETHUSDT:', matches);
}

run().catch(console.error);
