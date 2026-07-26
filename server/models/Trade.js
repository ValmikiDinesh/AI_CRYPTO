import mongoose from 'mongoose';

const tradeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  asset: { type: String, required: true, index: true },
  action: { type: String, enum: ['BUY', 'SELL'], required: true },
  type: { type: String, enum: ['spot', 'futures', 'paper'], default: 'paper' },
  side: { type: String, enum: ['long', 'short'], default: 'long' },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  quantity: { type: Number, required: true },
  positionSize: { type: Number },       // % of portfolio
  leverage: { type: Number, default: 1 },
  stopLoss: { type: Number },
  takeProfit: { type: Number },
  confidence: { type: Number, min: 0, max: 1 },
  riskScore: { type: Number, min: 0, max: 1 },
  pnl: { type: Number, default: 0 },
  pnlPercent: { type: Number, default: 0 },
  fees: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['pending', 'open', 'closed', 'cancelled', 'failed'],
    default: 'pending',
  },
  reasoning: { type: String },
  signalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Signal' },
  exchangeOrderId: { type: String },
  exchange: { type: String, default: 'binance_testnet' },
  executedAt: { type: Date },
  closedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed },
  // Dynamic Profit Engine fields
  maxProfitReached: { type: Number, default: 0 },       // MFE: highest unrealized profit during trade lifetime
  maxDrawdownReached: { type: Number, default: 0 },     // MAE: deepest unrealized loss during trade lifetime
  lockedMinProfit: { type: Number },                     // price level where SL was moved to guarantee profit
  dynamicTrailingPct: { type: Number },                  // ATR-based trailing % active on this trade
}, {
  timestamps: true,
});

tradeSchema.index({ userId: 1, createdAt: -1 });
tradeSchema.index({ asset: 1, status: 1 });
tradeSchema.index({ status: 1, createdAt: -1 });
tradeSchema.index({ status: 1, closedAt: -1 });

export default mongoose.model('Trade', tradeSchema);
