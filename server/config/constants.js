// ─── Supported Assets ────────────────────────────────────────────
export const SUPPORTED_ASSETS = (process.env.SUPPORTED_ASSETS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,1000SHIBUSDT,1000PEPEUSDT,WIFUSDT,1000FLOKIUSDT,1000BONKUSDT,AVAXUSDT,DOTUSDT,POLUSDT,LTCUSDT')
  .split(',')
  .map((s) => s.trim());

// ─── Risk Management Defaults ────────────────────────────────────
export const RISK = {
  MAX_RISK_PER_TRADE: parseFloat(process.env.MAX_RISK_PER_TRADE) || 0.01,   // 1%
  MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS) || 0.05,           // 5%
  MAX_PORTFOLIO_DRAWDOWN: parseFloat(process.env.MAX_PORTFOLIO_DRAWDOWN) || 0.10, // 10%
  MAX_LEVERAGE: 5,
  MAX_OPEN_POSITIONS: 5,
  MIN_CONFIDENCE_THRESHOLD: 0.65,
  EMERGENCY_VOLATILITY_THRESHOLD: 0.08, // 8% price swing triggers emergency
};

// ─── Trading Intervals ──────────────────────────────────────────
export const INTERVALS = {
  CANDLE_INTERVAL: '5m',         // 5-minute candles
  ANALYSIS_CYCLE_MS: 60_000,     // run analysis every 60s
  HEALTH_CHECK_MS: 30_000,       // agent health ping every 30s
  REBALANCE_INTERVAL_MS: 300_000, // rebalance every 5 min
};

// ─── Agent Names ─────────────────────────────────────────────────
export const AGENT_NAMES = {
  SUPERVISOR: 'supervisor',
  MARKET: 'market',
  TECHNICAL: 'technical',
  SENTIMENT: 'sentiment',
  PREDICTION: 'prediction',
  FUSION: 'fusion',
  RISK: 'risk',
  EXECUTION: 'execution',
  PORTFOLIO: 'portfolio',
  LEARNING: 'learning',
};

// ─── Signal Actions ──────────────────────────────────────────────
export const ACTIONS = {
  BUY: 'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
};

// ─── Trade Types ─────────────────────────────────────────────────
export const TRADE_TYPES = {
  SPOT: 'spot',
  FUTURES: 'futures',
  PAPER: 'paper',
};

export default { SUPPORTED_ASSETS, RISK, INTERVALS, AGENT_NAMES, ACTIONS, TRADE_TYPES };
