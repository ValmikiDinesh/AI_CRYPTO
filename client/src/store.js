import { create } from 'zustand';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_API_URL || '';

// ─── Socket Connection ──────────────────────────────────────────
const socket = io(SOCKET_URL, {
  transports: ['websocket', 'polling'],
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 10,
});

export { socket };

// ─── Market Store ────────────────────────────────────────────────
export const useMarketStore = create((set, get) => ({
  prices: {},
  candles: {},
  connected: false,

  setPrice: (asset, price) =>
    set((state) => ({
      prices: { ...state.prices, [asset]: price },
    })),

  setCandles: (asset, candles) =>
    set((state) => ({
      candles: { ...state.candles, [asset]: candles },
    })),

  addCandle: (asset, candle) =>
    set((state) => {
      const existing = state.candles[asset] || [];
      const updated = [...existing, candle].slice(-200);
      return { candles: { ...state.candles, [asset]: updated } };
    }),

  setConnected: (val) => set({ connected: val }),
}));

// ─── Signal Store ────────────────────────────────────────────────
export const useSignalStore = create((set) => ({
  technicalSignals: {},
  sentimentSignals: {},
  predictions: {},
  fusedSignals: {},
  signalHistory: [],

  setTechnicalSignal: (asset, signal) =>
    set((state) => ({
      technicalSignals: { ...state.technicalSignals, [asset]: signal },
    })),

  setSentimentSignal: (asset, signal) =>
    set((state) => ({
      sentimentSignals: { ...state.sentimentSignals, [asset]: signal },
    })),

  setPrediction: (asset, prediction) =>
    set((state) => ({
      predictions: { ...state.predictions, [asset]: prediction },
    })),

  setFusedSignal: (asset, signal) =>
    set((state) => ({
      fusedSignals: { ...state.fusedSignals, [asset]: signal },
      signalHistory: [
        { ...signal, timestamp: Date.now() },
        ...state.signalHistory,
      ].slice(0, 100),
    })),
}));

// ─── Portfolio Store ─────────────────────────────────────────────
export const usePortfolioStore = create((set) => ({
  portfolio: {
    totalBalance: 0,
    availableBalance: 0,
    totalPnl: 0,
    totalPnlPercent: 0,
    dailyPnl: 0,
    winRate: 0,
    openPositions: 0,
    allocation: [],
    winningTrades: 0,
    losingTrades: 0,
    totalTrades: 0,
    walletBalance: 0,
    tradingPaused: false,
    targetProfitThreshold: 1100,
    baseTradingCapital: 1000,
  },

  setPortfolio: (data) => set((state) => ({ portfolio: { ...state.portfolio, ...data } })),
}));

// ─── Agent Store ─────────────────────────────────────────────────
export const useAgentStore = create((set) => ({
  agents: {},
  emergencyStop: false,
  riskEvents: [],
  ensemble: {},

  setAgentHealth: (data) =>
    set({
      agents: data.agents || {},
      emergencyStop: data.emergencyStop || false,
      ensemble: data.ensemble || {},
    }),

  addRiskEvent: (event) =>
    set((state) => ({
      riskEvents: [event, ...state.riskEvents].slice(0, 50),
    })),
}));

// ─── Trade Store ─────────────────────────────────────────────────
export const useTradeStore = create((set) => ({
  recentTrades: [],

  addTrade: (trade) =>
    set((state) => ({
      recentTrades: [trade, ...state.recentTrades].slice(0, 50),
    })),
}));

// ─── Socket Event Listeners ─────────────────────────────────────
socket.on('connect', () => {
  useMarketStore.getState().setConnected(true);
});

socket.on('disconnect', () => {
  useMarketStore.getState().setConnected(false);
});

socket.on('market:data', (data) => {
  if (data.asset && data.price) {
    useMarketStore.getState().setPrice(data.asset, data.price);
  }
});

socket.on('market:tick', (data) => {
  if (data.asset && data.price) {
    useMarketStore.getState().setPrice(data.asset, data.price);
  }
});

socket.on('market:candle', (data) => {
  if (data.asset && data.candle) {
    useMarketStore.getState().addCandle(data.asset, data.candle);
  }
});

socket.on('signal:technical', (data) => {
  if (data.asset) useSignalStore.getState().setTechnicalSignal(data.asset, data);
});

socket.on('signal:sentiment', (data) => {
  if (data.asset) useSignalStore.getState().setSentimentSignal(data.asset, data);
});

socket.on('signal:prediction', (data) => {
  if (data.asset) useSignalStore.getState().setPrediction(data.asset, data);
});

socket.on('signal:fused', (data) => {
  if (data.asset) useSignalStore.getState().setFusedSignal(data.asset, data);
});

socket.on('portfolio:update', (data) => {
  usePortfolioStore.getState().setPortfolio(data);
});

socket.on('agents:health', (data) => {
  useAgentStore.getState().setAgentHealth(data);
});

socket.on('risk:event', (data) => {
  useAgentStore.getState().addRiskEvent(data);
});

socket.on('trade:execution', (data) => {
  useTradeStore.getState().addTrade(data);
});

socket.on('system:emergency', (data) => {
  useAgentStore.setState({ emergencyStop: true });
});

// ─── Binance Direct WebSocket Connection (Millisecond Pricing) ───
const BINANCE_WS_URL = 'wss://fstream.binance.com/ws';
let binanceWs = null;
const assetsList = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 
  'DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 
  'AVAXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT', 'BOMEUSDT', 'PEOPLEUSDT', 'PORTALUSDT', 
  'HEIUSDT', 'IDUSDT', 'STGUSDT', 'EPICUSDT', 'RENDERUSDT', 'PENDLEUSDT', 'INJUSDT', 'OPUSDT'
];

function connectBinanceWS() {
  if (binanceWs) return;

  try {
    binanceWs = new WebSocket(BINANCE_WS_URL);

    binanceWs.onopen = () => {
      console.log('Connected directly to Binance Futures public WebSocket for real-time prices');
      const streams = assetsList.map(a => `${a.toLowerCase()}@aggTrade`);
      const subscribeMsg = {
        method: 'SUBSCRIBE',
        params: streams,
        id: 1,
      };
      binanceWs.send(JSON.stringify(subscribeMsg));
    };

    binanceWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.e === 'aggTrade') {
          const rawSymbol = data.s;
          const price = parseFloat(data.p);
          if (rawSymbol && price) {
            useMarketStore.getState().setPrice(rawSymbol.toUpperCase(), price);
          }
        }
      } catch (err) {
        // silent parse error
      }
    };

    binanceWs.onclose = () => {
      console.warn('Binance WebSocket disconnected. Reconnecting in 3 seconds...');
      binanceWs = null;
      setTimeout(connectBinanceWS, 3000);
    };

    binanceWs.onerror = (err) => {
      console.error('Binance WebSocket error:', err);
    };
  } catch (e) {
    console.error('Failed to initialize Binance WebSocket:', e);
  }
}

// Start the real-time feed
if (typeof window !== 'undefined') {
  connectBinanceWS();
}
