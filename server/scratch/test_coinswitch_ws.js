import { io } from 'socket.io-client';

console.log("Connecting to CoinSwitch Pro Futures WebSocket...");

const socket = io("wss://ws.coinswitch.co/exchange_2", {
  path: "/pro/realtime-rates-socket/futures/exchange_2",
  transports: ["websocket"]
});

socket.on("connect", () => {
  console.log("✅ Connected to CoinSwitch Pro Futures WebSocket! ID:", socket.id);
  
  const pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "POLUSDT"];
  pairs.forEach(pair => {
    socket.emit("FETCH_TICKER_INFO_CS_PRO", { event: "subscribe", pair });
    console.log(`Subscribed to ${pair}`);
  });
});

socket.on("connect_error", (err) => {
  console.error("❌ Connection error:", err.message);
});

socket.on("FETCH_TICKER_INFO_CS_PRO", (data) => {
  console.log("⚡ [WS TICKER UPDATE]:", JSON.stringify(data));
});

setTimeout(() => {
  console.log("Closing test socket after 15 seconds...");
  socket.close();
  process.exit(0);
}, 15000);
