import mongoose from 'mongoose';

const agentLogSchema = new mongoose.Schema({
  agent: {
    type: String,
    required: true,
    index: true,
  },
  level: {
    type: String,
    enum: ['info', 'warn', 'error', 'debug'],
    default: 'info',
  },
  action: { type: String },           // e.g. "analysis_complete", "trade_executed"
  message: { type: String, required: true },
  duration: { type: Number },          // ms taken for the action
  input: { type: mongoose.Schema.Types.Mixed },
  output: { type: mongoose.Schema.Types.Mixed },
  error: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

agentLogSchema.index({ agent: 1, createdAt: -1 });
agentLogSchema.index({ level: 1, agent: 1 });

// TTL: auto-delete logs older than 14 days
agentLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

export default mongoose.model('AgentLog', agentLogSchema);
