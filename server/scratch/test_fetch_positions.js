import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  await exchange.loadMarkets();
  console.log('Fetching positions for ETHUSDT...');
  const positions = await exchange.fetchPositions(['ETHUSDT']);
  console.log('All positions returned for ETHUSDT:');
  console.log(JSON.stringify(positions, null, 2));
  
  const filtered = positions.filter((p) => parseFloat(p.contracts) > 0);
  console.log('Filtered positions (contracts > 0):', filtered);
}

run().catch(console.error);
