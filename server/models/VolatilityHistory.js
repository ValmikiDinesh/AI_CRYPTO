import mongoose from 'mongoose';

/**
 * VolatilityHistory Model
 * Stores historical daily volatility data per asset for Day-of-Week profiling.
 * Pre-populated with 60 days of data via bootstrap script, then updated daily by LearningAgent.
 */
const volatilityHistorySchema = new mongoose.Schema({
  asset: { type: String, required: true, index: true },
  date: { type: Date, required: true },
  dayOfWeek: { type: Number, min: 0, max: 6 },  // 0=Sunday, 6=Saturday
  highPrice: { type: Number, required: true },
  lowPrice: { type: Number, required: true },
  closePrice: { type: Number },
  dailyRange: { type: Number },          // high - low
  dailyRangePct: { type: Number },       // ((high - low) / close) * 100
  avgATR: { type: Number },              // Average True Range for the day
  volume: { type: Number },
}, {
  timestamps: true,
});

// Compound index for fast lookups: find all volatility data for an asset on a specific date
volatilityHistorySchema.index({ asset: 1, date: 1 }, { unique: true });

// Index for day-of-week queries: find average volatility for an asset on Mondays, Tuesdays, etc.
volatilityHistorySchema.index({ asset: 1, dayOfWeek: 1 });

export default mongoose.model('VolatilityHistory', volatilityHistorySchema);
