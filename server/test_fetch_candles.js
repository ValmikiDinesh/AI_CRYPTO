import { fetchCandles } from './services/exchangeService.js';
(async () => {
  const result = await fetchCandles('BTCUSDT', '5m', 2);
  console.log("Result:", result);
  process.exit(0);
})();
