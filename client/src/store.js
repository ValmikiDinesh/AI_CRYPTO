import { create } from 'zustand';
import { io } from 'socket.io-client';

const SOCKET_URL = (import.meta.env && import.meta.env.VITE_SOCKET_URL)
  ? import.meta.env.VITE_SOCKET_URL
  : '';

// ─── Socket Connection ──────────────────────────────────────────
const socket = io(SOCKET_URL, {
  transports: ['websocket', 'polling'],
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 10,
});

export { socket };

// ─── Auth Store ────────────────────────────────────────────────
export const useAuthStore = create((set) => ({
  token: localStorage.getItem('token') || null,
  user: null,
  isAuthenticated: !!localStorage.getItem('token'),
  
  login: (token, user) => {
    localStorage.setItem('token', token);
    set({ token, user, isAuthenticated: true });
  },
  
  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, user: null, isAuthenticated: false });
  },

  setUser: (user) => set({ user }),
}));

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
  allTrades: [],
  stats: null,

  setPortfolio: (data) => {
    if (data) {
      useMarketStore.getState().setConnected(true);
      // Only seed prices from portfolio if no live WebSocket price exists yet
      if (data.positions && Array.isArray(data.positions)) {
        const currentPrices = useMarketStore.getState().prices;
        data.positions.forEach((p) => {
          if (p && p.asset && p.currentPrice > 0 && !currentPrices[p.asset]) {
            useMarketStore.getState().setPrice(p.asset, p.currentPrice);
          }
        });
      }
    }
    set((state) => ({ portfolio: { ...state.portfolio, ...data } }));
  },

  setAllTrades: (trades) => set({ allTrades: Array.isArray(trades) ? trades : [] }),
  setStats: (stats) => set({ stats }),
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

// ─── Currency Store ─────────────────────────────────────────────
export const useCurrencyStore = create((set) => ({
  currency: localStorage.getItem('user_currency') || 'USD',
  rate: parseFloat(localStorage.getItem('currency_rate') || '96.29'), // default to 96.29
  setCurrency: (currency) => {
    localStorage.setItem('user_currency', currency);
    set({ currency });
  },
  setRate: (rate) => {
    localStorage.setItem('currency_rate', rate.toString());
    set({ rate: parseFloat(rate) });
  },
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
  if (data) {
    if (data.positions && Array.isArray(data.positions)) {
      const seen = new Set();
      data.positions = data.positions.filter((p) => {
        if (p && p.status === 'open') {
          if (seen.has(p.asset)) return false;
          seen.add(p.asset);
        }
        return true;
      });
      // Only seed prices from portfolio if no live WebSocket price exists yet
      const currentPrices = useMarketStore.getState().prices;
      data.positions.forEach((p) => {
        if (p && p.asset && p.currentPrice > 0 && !currentPrices[p.asset]) {
          useMarketStore.getState().setPrice(p.asset, p.currentPrice);
        }
      });
    }
    usePortfolioStore.getState().setPortfolio(data);
  }
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
// Real-time prices are loaded and updated via backend Socket.io stream.
