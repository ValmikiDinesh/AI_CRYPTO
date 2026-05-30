import { getExchange } from '../services/exchangeService.js';
import 'dotenv/config';

async function run() {
  const exchange = getExchange();
  exchange.verbose = true; // Enable verbose debugging
  
  console.log('Fetching positions with verbose=true...');
  try {
    const positions = await exchange.fetchPositions();
    console.log(`Success! Fetched ${positions.length} positions.`);
  } catch (err) {
    console.error('Error during fetchPositions:', err);
  }
}

run().catch(console.error);
