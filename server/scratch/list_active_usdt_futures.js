import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  console.log('Loading markets...');
  const markets = await exchange.loadMarkets();
  
  const usdtFutures = Object.values(markets).filter(m => 
    m.active && 
    m.quote === 'USDT' && 
    (m.contract || m.type === 'swap' || m.type === 'future')
  );
  
  console.log('Total active USDT futures/swaps:', usdtFutures.length);
  console.log('Sample:', usdtFutures.slice(0, 10).map(m => m.symbol));
}

run().catch(console.error);
