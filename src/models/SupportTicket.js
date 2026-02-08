const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
  customerEmail: { type: String, required: true, index: true },
  customerName: { type: String },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: { type: String, enum: ['open', 'responded', 'waiting', 'escalated', 'resolved', 'closed'], default: 'open', index: true },
  category: { type: String, enum: ['order', 'shipping', 'return', 'product', 'billing', 'general'], default: 'general' },
  source: { type: String, enum: ['email', 'chat', 'openclaw', 'storefront', 'manual'], default: 'manual' },
  orderId: { type: String },
  assignedTo: { type: String, default: 'openclaw' },
  responses: [{
    message: { type: String, required: true },
    from: { type: String, required: true }, // 'openclaw', 'agent', 'customer'
    time: { type: Date, default: Date.now },
    isAiGenerated: { type: Boolean, default: false },
  }],
  tags: [String],
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative', 'angry'], default: 'neutral' },
  resolution: { type: String },
  resolvedAt: { type: Date },
  firstResponseAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

supportTicketSchema.index({ createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
