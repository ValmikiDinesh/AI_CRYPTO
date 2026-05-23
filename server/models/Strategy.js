import mongoose from 'mongoose';

const strategySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: { type: String },
  active: { type: Boolean, default: true },
  assets: [{ type: String }],
  parameters: {
    technicalWeight: { type: Number, default: 0.35 },
    sentimentWeight: { type: Number, default: 0.20 },
    predictionWeight: { type: Number, default: 0.30 },
    momentumWeight: { type: Number, default: 0.15 },
    minConfidence: { type: Number, default: 0.65 },
    maxRiskPerTrade: { type: Number, default: 0.01 },
    stopLossPercent: { type: Number, default: 0.02 },
    takeProfitPercent: { type: Number, default: 0.04 },
    maxLeverage: { type: Number, default: 5 },
  },
  performance: {
    totalTrades: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    avgPnl: { type: Number, default: 0 },
    sharpeRatio: { type: Number, default: 0 },
    maxDrawdown: { type: Number, default: 0 },
  },
  version: { type: Number, default: 1 },
  lastOptimizedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

export default mongoose.model('Strategy', strategySchema);
