const rawAssets = (process.env.SUPPORTED_ASSETS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,1000SHIBUSDT,1000PEPEUSDT,WIFUSDT,1000FLOKIUSDT,1000BONKUSDT,AVAXUSDT,DOTUSDT,POLUSDT,LTCUSDT,BOMEUSDT,PEOPLEUSDT')
  .split(',')
  .map((s) => s.trim());

if (!rawAssets.includes('BOMEUSDT')) rawAssets.push('BOMEUSDT');
if (!rawAssets.includes('PEOPLEUSDT')) rawAssets.push('PEOPLEUSDT');

export const SUPPORTED_ASSETS = rawAssets;

export const CORE_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT'];
export const MEME_ASSETS = ['DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'BOMEUSDT', 'PEOPLEUSDT'];
export const RECOMMENDED_ASSETS = ['AVAXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT'];

// ─── Risk Management Defaults ────────────────────────────────────
export const RISK = {
  MAX_RISK_PER_TRADE: parseFloat(process.env.MAX_RISK_PER_TRADE) || 0.01,   // 1%
  MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS) || 0.05,           // 5%
  MAX_PORTFOLIO_DRAWDOWN: parseFloat(process.env.MAX_PORTFOLIO_DRAWDOWN) || 0.10, // 10%
  MAX_LEVERAGE: 5,
  MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS) || 150,
  MAX_CORE_POSITIONS: parseInt(process.env.MAX_CORE_POSITIONS) || 50,
  MAX_MEME_POSITIONS: parseInt(process.env.MAX_MEME_POSITIONS) || 50,
  MAX_RECOMMENDED_POSITIONS: parseInt(process.env.MAX_RECOMMENDED_POSITIONS) || 50,
  MIN_CONFIDENCE_THRESHOLD: parseFloat(process.env.MIN_CONFIDENCE_THRESHOLD) || 0.30,
  EMERGENCY_VOLATILITY_THRESHOLD: 0.08, // 8% price swing triggers emergency
};

// ─── Trading Intervals ──────────────────────────────────────────
export const INTERVALS = {
  CANDLE_INTERVAL: '5m',         // 5-minute candles
  ANALYSIS_CYCLE_MS: parseInt(process.env.ANALYSIS_CYCLE_MS) || 5_000,      // run analysis every 5s (high-frequency)
  HEALTH_CHECK_MS: 15_000,       // agent health ping every 15s
  REBALANCE_INTERVAL_MS: 60_000, // rebalance every 60s
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

export default { SUPPORTED_ASSETS, CORE_ASSETS, MEME_ASSETS, RECOMMENDED_ASSETS, RISK, INTERVALS, AGENT_NAMES, ACTIONS, TRADE_TYPES };
