const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    // Core identification
                                            title: { type: String, required: true, index: true },
    slug: { type: String, unique: true, index: true },
    description: { type: String, default: '' },
    descriptionHtml: { type: String, default: '' },

    // WooCommerce sync
    woocommerceProductId: { type: String, default: null, index: true },
    woocommerceSlug: { type: String, default: null },
    woocommerceStatus: { type: String, enum: ['draft', 'publish', 'published', 'pending', 'private'], default: 'draft' },
    lastSyncedToWooCommerce: { type: Date, default: null },

    // Categorization
    category: { type: String, index: true },
    tags: [{ type: String }],
    productType: { type: String, default: '' },
    vendor: { type: String, default: 'XeriaCO' },

    // Pricing (all stored in USD internally)
    costUsd: { type: Number, required: true },
    shippingCostUsd: { type: Number, default: 0 },
    totalCostUsd: { type: Number, default: 0 },
    sellingPriceAud: { type: Number, default: 0 },
    comparePriceAud: { type: Number, default: null }, // strikethrough price
    profitAud: { type: Number, default: 0 },
    profitMarginPercent: { type: Number, default: 0 },
    markupPercent: { type: Number, default: 0 },

    // Supplier info
    supplier: {
          name: { type: String, default: '' },
          platform: { type: String, enum: ['aliexpress', 'cjdropshipping', 'spocket', 'unknown', 'other'], default: 'aliexpress' },
          url: { type: String, default: '' },
          id: { type: String, default: '' },
          productId: { type: String, default: '' },
          rating: { type: Number, default: 0 },
          totalOrders: { type: Number, default: 0 },
          shippingDays: { min: Number, max: Number },
          lastChecked: { type: Date, default: null },
    },

    // Featured image
    featuredImage: { type: String, default: '' },

    // Images (supports both object array from pipeline and string array from ImageSourcer)
    images: { type: mongoose.Schema.Types.Mixed, default: [] },

    // AI-generated content
    aiContent: {
          title: { type: String, default: '' },
          description: { type: String, default: '' },
          shortDescription: { type: String, default: '' },
          seoTitle: { type: String, default: '' },
          seoDescription: { type: String, default: '' },
          generatedAt: { type: Date },
          model: { type: String, default: '' },
    },

    // Variants (weight, size, color etc)
    variants: [{
          title: { type: String },
          option1: { type: String },
          option2: { type: String },
          option3: { type: String },
          sku: { type: String },
          costUsd: { type: Number },
          sellingPriceAud: { type: Number },
          weight: { type: Number },
          weightUnit: { type: String, default: 'g' },
          woocommerceVariantId: { type: String },
    }],

    // Pipeline tracking
    pipeline: {
          source: { type: String, default: '' }, // 'trendscout', 'manual', 'import'
          discoveredAt: { type: Date, default: Date.now },
          researchScore: { type: Number, default: 0, min: 0, max: 100 },
          trendScore: { type: Number, default: 0, min: 0, max: 100 },
          competitorCount: { type: Number, default: 0 },
          approved: { type: Boolean, default: false },
          approvedAt: { type: Date, default: null },
          rejectionReason: { type: String, default: '' },
          runId: { type: String, default: '' },
    },

    // Fraud / quality flags
    flags: [{
          type: { type: String },
          reason: { type: String },
          createdAt: { type: Date, default: Date.now },
    }],

    // Analytics
    analytics: {
          views: { type: Number, default: 0 },
          clicks: { type: Number, default: 0 },
          addToCarts: { type: Number, default: 0 },
          purchases: { type: Number, default: 0 },
          revenue: { type: Number, default: 0 },
    },

    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '' },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});

// Indexes for common queries
productSchema.index({ 'pipeline.researchScore': -1 });
productSchema.index({ 'profitMarginPercent': -1 });
productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ 'supplier.platform': 1 });

// Pre-save: compute derived pricing fields
productSchema.pre('save', function(next) {
    // Total cost
                    this.totalCostUsd = this.costUsd + this.shippingCostUsd;

                    // Generate slug if missing
                    if (!this.slug && this.title) {
                          this.slug = this.title
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, '-')
                            .replace(/^-|-$/g, '')
                            + '-' + Date.now().toString(36);
                    }

                    next();
});

module.exports = mongoose.model('Product', productSchema);
