import mongoose from 'mongoose';

const alertSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  type: {
    type: String,
    enum: ['signal', 'risk', 'trade', 'system', 'price', 'agent'],
    required: true,
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info',
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  asset: { type: String },
  read: { type: Boolean, default: false },
  actionUrl: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

alertSchema.index({ userId: 1, read: 1, createdAt: -1 });

export default mongoose.model('Alert', alertSchema);
