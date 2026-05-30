import WebSocket from 'ws';
import 'dotenv/config';

const targetStreams = [
  'portalusdt@kline_5m',
  'heiusdt@kline_5m',
  'idusdt@kline_5m',
  'labusdt@kline_5m',
  'stgusdt@kline_5m',
  'epicusdt@kline_5m'
];

const wsUrl = `wss://stream.binancefuture.com/stream?streams=${targetStreams.join('/')}`;
console.log('Connecting to WebSocket:', wsUrl);

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('Binance Futures Testnet WebSocket connected successfully!');
});

let msgCount = 0;
ws.on('message', (data) => {
  msgCount++;
  const parsed = JSON.parse(data.toString());
  console.log(`[MSG #${msgCount}] Stream: ${parsed.stream} | Event Type: ${parsed.data?.e} | Close Price: ${parsed.data?.k?.c}`);
  
  if (msgCount >= 10) {
    console.log('Test completed. Closing connection.');
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('WebSocket Error:', err.message);
});

ws.on('close', () => {
  console.log('WebSocket connection closed.');
});

// Set a timeout to close if no messages received
setTimeout(() => {
  if (msgCount === 0) {
    console.warn('⚠️ No messages received after 8 seconds. Closing.');
    ws.close();
  }
}, 8000);
