import mongoose from 'mongoose';

const signalSchema = new mongoose.Schema({
  asset: { type: String, required: true, index: true },
  action: { type: String, enum: ['BUY', 'SELL', 'HOLD'], required: true },
  confidence: { type: Number, min: 0, max: 1, required: true },
  riskScore: { type: Number, min: 0, max: 1 },
  source: {
    type: String,
    enum: ['technical', 'sentiment', 'prediction', 'fusion'],
    required: true,
  },
  positionSize: { type: String },       // e.g. "2%"
  stopLoss: { type: Number },
  takeProfit: { type: Number },
  reasoning: { type: String },
  indicators: { type: mongoose.Schema.Types.Mixed },  // raw indicator data
  weights: { type: mongoose.Schema.Types.Mixed },      // fusion weights used
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'executed', 'expired'],
    default: 'pending',
  },
  expiresAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

signalSchema.index({ asset: 1, createdAt: -1 });
signalSchema.index({ status: 1, source: 1 });

// TTL: auto-delete signals older than 6 hours to manage storage
signalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 6 * 60 * 60 });

export default mongoose.model('Signal', signalSchema);
