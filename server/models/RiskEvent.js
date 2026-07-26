import mongoose from 'mongoose';

const riskEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'max_trade_risk',
      'daily_loss_limit',
      'drawdown_limit',
      'high_volatility',
      'overtrading',
      'leverage_exceeded',
      'emergency_shutdown',
      'position_limit',
      'low_confidence',
      'high_risk_score',
      'duplicate_position',
      'macro_trend_blocked',
      'trend_alignment_mismatch',
      'counter_trend_blocked',
      'whipsaw_cooldown',
      'portfolio_square_off',
      'asset_loss_cooldown',
      'system_warmup_cooldown',
      'asset_disabled',
      'asset_ignored_closing',
    ],
    required: true,
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical', 'emergency'],
    default: 'warning',
  },
  asset: { type: String },
  message: { type: String, required: true },
  currentValue: { type: Number },
  threshold: { type: Number },
  actionTaken: { type: String },   // e.g. "trade_blocked", "positions_closed", "system_paused"
  resolved: { type: Boolean, default: false },
  resolvedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

riskEventSchema.index({ type: 1, createdAt: -1 });
riskEventSchema.index({ severity: 1, resolved: 1 });

export default mongoose.model('RiskEvent', riskEventSchema);
