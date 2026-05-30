import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();
  
  console.log('1. Fetching all positions...');
  try {
    const allPositions = await exchange.fetchPositions();
    console.log(`Successfully fetched ${allPositions.length} positions!`);
    const active = allPositions.filter(p => parseFloat(p.contracts) > 0);
    console.log(`Active positions: ${active.length}`);
    if (active.length > 0) {
      console.log('Sample active position:', JSON.stringify(active[0], null, 2));
    }
  } catch (err) {
    console.error('All positions fetch failed:', err.message);
  }

  console.log('\n2. Fetching with unified symbol ETH/USDT:USDT...');
  try {
    const ethPositions = await exchange.fetchPositions(['ETH/USDT:USDT']);
    console.log(`Successfully fetched ${ethPositions.length} positions for ETH/USDT:USDT!`);
  } catch (err) {
    console.error('ETH/USDT:USDT fetch failed:', err.message);
  }
}

run().catch(console.error);
