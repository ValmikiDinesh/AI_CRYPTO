import mongoose from 'mongoose';

const predictionSchema = new mongoose.Schema({
  asset: { type: String, required: true, index: true },
  model: { type: String, default: 'ensemble' },  // lstm, xgboost, transformer, ensemble
  horizon: { type: String, default: '1h' },       // prediction time horizon
  direction: { type: String, enum: ['up', 'down', 'neutral'], required: true },
  probability: { type: Number, min: 0, max: 1, required: true },
  predictedPrice: { type: Number },
  currentPrice: { type: Number },
  priceChangePercent: { type: Number },
  features: { type: mongoose.Schema.Types.Mixed },   // input features snapshot
  accuracy: { type: Number },                          // retrospective accuracy
  verified: { type: Boolean, default: false },
  actualDirection: { type: String, enum: ['up', 'down', 'neutral'] },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

predictionSchema.index({ asset: 1, createdAt: -1 });

export default mongoose.model('Prediction', predictionSchema);
