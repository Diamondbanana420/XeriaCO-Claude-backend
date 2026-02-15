const mongoose = require('mongoose');

const marketingContentSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productTitle: { type: String, required: true },
  productImage: String, // original product image
  productPrice: Number,
  productCategory: String,

  // Generated content
  caption: {
    instagram: String,
    facebook: String,
    pinterest: String,
    hashtags: [String],
    cta: String,
  },
  
  image: {
    url: String,         // fal.ai generated image URL
    prompt: String,      // prompt used to generate
    model: { type: String, default: 'flux-1.1-pro' },
    status: { type: String, enum: ['pending', 'generating', 'ready', 'failed'], default: 'pending' },
    error: String,
    generatedAt: Date,
  },

  // Approval workflow
  status: {
    type: String,
    enum: ['generating', 'pending_approval', 'approved', 'rejected', 'posted', 'failed'],
    default: 'generating',
  },
  
  approvedAt: Date,
  rejectedAt: Date,
  rejectionReason: String,
  postedAt: Date,
  postResults: mongoose.Schema.Types.Mixed, // results from social posting

  // Pipeline reference
  pipelineRunId: String,
  generationCost: { type: Number, default: 0 }, // USD cost tracking
  
  // Regeneration tracking
  regenerationCount: { type: Number, default: 0 },
  regeneratedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingContent' },

}, { timestamps: true });

marketingContentSchema.index({ status: 1, createdAt: -1 });
marketingContentSchema.index({ productId: 1 });

module.exports = mongoose.model('MarketingContent', marketingContentSchema);
