import mongoose from 'mongoose';

const positionSchema = new mongoose.Schema({
  tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade' },
  asset: { type: String, required: true },
  side: { type: String, enum: ['long', 'short'], required: true },
  entryPrice: { type: Number, required: true },
  currentPrice: { type: Number, default: 0 },
  quantity: { type: Number, required: true },
  leverage: { type: Number, default: 1 },
  unrealizedPnl: { type: Number, default: 0 },
  realizedPnl: { type: Number, default: 0 },
  fees: { type: Number, default: 0 },
  stopLoss: { type: Number },
  takeProfit: { type: Number },
  exchangeOrderId: { type: String },
  stopLossOrderId: { type: String },
  highestPrice: { type: Number },
  lowestPrice: { type: Number },
  trailingPct: { type: Number },
  highestProfitMilestone: { type: Number, default: 0 },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  // Dynamic Profit Engine fields
  maxProfitReached: { type: Number, default: 0 },       // MFE: highest unrealized profit during position lifetime
  maxDrawdownReached: { type: Number, default: 0 },     // MAE: deepest unrealized loss during position lifetime
  lockedMinProfit: { type: Number },                     // price level where SL was moved to guarantee profit
  dynamicTrailingPct: { type: Number },                  // ATR-based trailing distance for this position
  category: { type: String, enum: ['core', 'meme', 'recommended', 'other'], default: 'other' },
  activeStrategy: { type: String },                      // 'trend_sniper' or 'hft_scalping'
  hasVirtualStop: { type: Boolean, default: false },
  hasVirtualTakeProfit: { type: Boolean, default: false },
}, { _id: true });

const portfolioSchema = new mongoose.Schema({
  userId: {
    type: String,
    default: 'system',
    index: true,
    unique: true,
    validate: {
      validator: function(v) {
        return v !== "000000000000000000000000";
      },
      message: "GHOST PROFILE CREATION ATTEMPT BLOCKED!"
    }
  },
  totalBalance: { type: Number, default: 100 },   // paper-trading start capital
  availableBalance: { type: Number, default: 100 },
  totalPnl: { type: Number, default: 0 },
  totalPnlPercent: { type: Number, default: 0 },
  dailyPnl: { type: Number, default: 0 },
  maxDrawdown: { type: Number, default: 0 },
  winRate: { type: Number, default: 0 },
  totalTrades: { type: Number, default: 0 },
  winningTrades: { type: Number, default: 0 },
  losingTrades: { type: Number, default: 0 },
  positions: [positionSchema],
  allocationBreakdown: [{
    asset: String,
    percentage: Number,
    value: Number,
  }],
  peakBalance: { type: Number, default: 100 },
  dailyLossToday: { type: Number, default: 0 },
  walletBalance: { type: Number, default: 0 },
  tradingPaused: { type: Boolean, default: false },
  isSquaringOff: { type: Boolean, default: false },
  targetProfitThreshold: { type: Number, default: 110 },
  baseTradingCapital: { type: Number, default: 100 },
  maxDailyLossPct: { type: Number, default: 20 },
  maxDailyTrades: { type: Number, default: 1000 },
  defaultLeverage: { type: Number, default: 1 },
  basketProfitTargetPct: { type: Number, default: 10 },
  sweepTargetProfitPct: { type: Number, default: 10 },
  manuallyDisabledAssets: { type: [String], default: [] },
  autoIgnoredAssets: { type: [String], default: [] },
  coinSwitchApiKey: { type: String, default: "" },
  coinSwitchApiSecret: { type: String, default: "" },
  entryOrderType: { type: String, enum: ['market', 'limit'], default: 'market' },
  exitOrderType: { type: String, enum: ['market', 'limit'], default: 'market' },
  enableDynamicScalp: { type: Boolean, default: false },
  enableTrailingStop: { type: Boolean, default: true },
  enableTrailingFloor: { type: Boolean, default: true },
  fixedScalpTargetUsd: { type: Number, default: 0 },
  fixedScalpStopLossUsd: { type: Number, default: 0 },
  minMarginFloor: { type: Number, default: 5.0 }, // Dynamic minimum margin floor
  trailingStopUsd: { type: Number },        // null = OFF, positive number = ON with that value
  trailingStopMinFloorUsd: { type: Number, default: 0.10 }, // Configurable minimum locked-in profit floor for trailing stop
  usdToInrRate: { type: Number, default: 96.54 },
  lastRebalancedAt: { type: Date },
  lastDailyDigestDate: { type: String },
  enableAILlmPredictions: { type: Boolean, default: false },
  aiLlmSequence: { type: [String], default: ['gemini', 'groq', 'openai'] },
  aiApiKeys: {
    gemini: { type: [String], default: [] },
    groq: { type: [String], default: [] },
    openai: { type: [String], default: [] }
  },
  activeStrategy: { type: String, enum: ['trend_sniper', 'hft_scalping'], default: 'trend_sniper' },
  strategySettings: {
    trend_sniper: {
      confidenceThreshold: { type: Number },
      stopLossAtr: { type: Number },
      takeProfitAtr: { type: Number }
    },
    hft_scalping: {
      confidenceThreshold: { type: Number },
      stopLossAtr: { type: Number },
      takeProfitAtr: { type: Number }
    }
  },
  telegramBotToken: { type: String, default: "" },
  telegramChatId: { type: String, default: "" }
}, {
  timestamps: true,
  versionKey: false,
});

// Virtual: current drawdown %
portfolioSchema.virtual('currentDrawdown').get(function () {
  if (this.peakBalance === 0) return 0;
  return (this.peakBalance - this.totalBalance) / this.peakBalance;
});

portfolioSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Portfolio', portfolioSchema);
