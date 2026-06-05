import ccxt from 'ccxt';
import 'dotenv/config';

async function run() {
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    secret: process.env.BINANCE_TESTNET_API_SECRET,
    enableRateLimit: true,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    },
  });
  exchange.enableDemoTrading(true);

  console.log('Fetching active positions from Binance Demo...');
  const positions = await exchange.fetchPositions();
  const active = positions.filter(p => parseFloat(p.contracts) > 0);

  console.log(`Found ${active.length} active positions on exchange:`);
  active.forEach(p => {
    console.log(`Symbol: ${p.symbol} | Side: ${p.side} | Entry: ${p.entryPrice} | Contracts: ${p.contracts} | Mark: ${p.markPrice} | Raw Symbol Info:`, p.info.symbol);
  });
}

run().catch(console.error);
