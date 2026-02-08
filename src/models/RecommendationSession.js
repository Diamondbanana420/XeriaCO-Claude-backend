const mongoose = require('mongoose');

const recommendationSessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },

    // User preferences from the quiz
    answers: {
          budget: { type: String, enum: ['under50', '50to100', '100to200', 'over200'], required: true },
          category: { type: String, required: true },
          occasion: { type: String, default: 'personal' },
          style: { type: String, default: 'modern' },
          priority: { type: String, enum: ['quality', 'value', 'trending', 'unique'], default: 'quality' },
    },

    // AI-generated recommendations
    recommendations: [{
          productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
          productSlug: String,
          productTitle: String,
          reason: String,
          score: { type: Number, min: 0, max: 100 },
          priceAud: Number,
          category: String,
    }],

    // Engagement tracking for product optimization
    engagement: {
          viewedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
          clickedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
          addedToCart: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
          purchased: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
          dismissed: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    },

    // Metadata
    provider: { type: String, default: 'emergent' },
    aiModel: String,
    responseTimeMs: Number,
    ipHash: String,
    userAgent: String,

    // Analytics aggregation helpers
    totalRecommendations: { type: Number, default: 0 },
    conversionOccurred: { type: Boolean, default: false },
    feedbackRating: { type: Number, min: 1, max: 5 },
    feedbackText: String,
}, {
    timestamps: true,
});

// Indexes for analytics queries
recommendationSessionSchema.index({ 'answers.category': 1, createdAt: -1 });
recommendationSessionSchema.index({ 'answers.budget': 1 });
recommendationSessionSchema.index({ 'answers.priority': 1 });
recommendationSessionSchema.index({ conversionOccurred: 1 });
recommendationSessionSchema.index({ createdAt: -1 });
recommendationSessionSchema.index({ 'recommendations.productId': 1 });

module.exports = mongoose.model('RecommendationSession', recommendationSessionSchema);
