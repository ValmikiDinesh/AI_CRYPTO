import mongoose from 'mongoose';

const marketDataSchema = new mongoose.Schema({
  asset: { type: String, required: true, index: true },
  interval: { type: String, default: '5m' },
  open: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  close: { type: Number, required: true },
  volume: { type: Number, required: true },
  quoteVolume: { type: Number },
  trades: { type: Number },
  takerBuyVolume: { type: Number },
  takerBuyQuoteVolume: { type: Number },
  openTime: { type: Date, required: true },
  closeTime: { type: Date, required: true },
  isClosed: { type: Boolean, default: false },
}, {
  timestamps: true,
});

marketDataSchema.index({ asset: 1, openTime: -1 });
marketDataSchema.index({ asset: 1, interval: 1, openTime: -1 }, { unique: true });

// TTL: auto-delete data older than 30 days to manage storage
marketDataSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('MarketData', marketDataSchema);
