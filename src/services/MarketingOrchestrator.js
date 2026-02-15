/**
 * MarketingOrchestrator — Central marketing automation engine
 * 
 * Deep integration with OpenClaw bot:
 * - All marketing events sent as Discord alerts
 * - OpenClaw can trigger any marketing action via admin API
 * - Marketing status included in dashboard
 * - Cron-compatible scheduled tasks
 */

const klaviyo = require('./KlaviyoService');
const socialPoster = require('./SocialPoster');
const contentGenerator = require('./ContentGenerator');

class MarketingOrchestrator {
  constructor() {
    this.stats = {
      socialPostsSent: 0,
      emailEventsSent: 0,
      productsMarketed: 0,
      newsletterSignups: 0,
      ordersTracked: 0,
      contentGenerated: 0,
      contentApproved: 0,
      contentRejected: 0,
      lastRun: null,
    };

    this.pendingProducts = [];
    this.isProcessing = false;
    this.postDelayMs = 30 * 60 * 1000; // 30min between social posts

    this.logger = null;
    this.clawdbotBridge = null;

    // Activity tracking for dashboard
    this.socialHistory = []; // ring buffer, max 100
    this.recentActivity = []; // ring buffer, max 200
    this.startedAt = new Date().toISOString();
  }

  init(logger, clawdbotBridge, aiGenerator) {
    this.logger = logger || console;
    this.clawdbotBridge = clawdbotBridge;

    // Initialize sub-services
    klaviyo.init(logger, clawdbotBridge);
    socialPoster.init(logger, clawdbotBridge, aiGenerator);
    contentGenerator.init(aiGenerator);
  }

  // ═══════════════════════════════════════
  // OPENCLAW ALERT HELPER
  // ═══════════════════════════════════════
  async _alertOpenClaw(type, data) {
    if (!this.clawdbotBridge) return;
    try {
      await this.clawdbotBridge.sendCommand(type, {
        ...data,
        timestamp: new Date().toISOString(),
        source: 'marketing',
      });
    } catch (err) {
      this.logger.warn(`Marketing: OpenClaw alert failed: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════
  // LIFECYCLE HOOKS
  // ═══════════════════════════════════════

  /**
   * Called when a product is approved and synced to Shopify
   * Triggers: social posting, Klaviyo catalog sync, new product email flow
   */
  async onProductLive(product) {
    this.logger.info(`Marketing: Product live — "${product.title}"`);
    const results = { social: null, klaviyo: null, catalog: null };

    // 1. Sync to Klaviyo catalog
    try {
      results.catalog = await klaviyo.syncProductToCatalog(product);
      this.stats.emailEventsSent++;
    } catch (err) {
      this.logger.warn(`Marketing: Klaviyo catalog sync failed: ${err.message}`);
    }

    // 2. Track new product event (triggers email flow)
    try {
      await klaviyo.trackNewProductAvailable(product);
    } catch (err) {
      this.logger.warn(`Marketing: Klaviyo event failed: ${err.message}`);
    }

    // 3. Queue social posting
    this.queueSocialPost(product);

    this.stats.productsMarketed++;
    this.stats.lastRun = new Date().toISOString();
    this._addActivity('product_live', `Product marketed: ${product.title}`, { productTitle: product.title });

    // 4. Alert OpenClaw
    await this._alertOpenClaw('marketing_product_live', {
      title: product.title,
      price: product.sellingPriceAud || product.price,
      category: product.category,
      image: product.featuredImage,
      socialQueued: true,
      klaviyoSynced: !!results.catalog,
    });

    return results;
  }

  /**
   * Called when a Shopify order arrives via webhook
   */
  async onOrderPlaced(order) {
    const email = order.email || order.customer?.email;
    if (!email) {
      this.logger.warn('Marketing: Order has no email');
      return;
    }

    try {
      await klaviyo.trackPlacedOrder(order);
      this.stats.emailEventsSent++;
      this.stats.ordersTracked++;

      await klaviyo.upsertProfile({
        email,
        firstName: order.customer?.first_name || order.billing_address?.first_name,
        lastName: order.customer?.last_name || order.billing_address?.last_name,
        phone: order.customer?.phone,
        properties: {
          last_order_date: new Date().toISOString(),
          total_spent: parseFloat(order.total_price || 0),
          order_count: order.customer?.orders_count || 1,
          country: order.shipping_address?.country_code || 'AU',
          city: order.shipping_address?.city || '',
        },
      });

      this.logger.info(`Marketing: Order tracked — ${email}, $${order.total_price}`);
      this._addActivity('order', `Order tracked: $${order.total_price} from ${email}`, { email, total: order.total_price });

      // Alert OpenClaw
      await this._alertOpenClaw('marketing_order_tracked', {
        email,
        orderTotal: order.total_price,
        orderNumber: order.order_number || order.id,
        itemCount: (order.line_items || []).length,
      });
    } catch (err) {
      this.logger.error(`Marketing: Order tracking failed: ${err.message}`);
    }
  }

  /**
   * Called when checkout starts on storefront
   */
  async onCheckoutStarted(email, cart) {
    if (!email) return;
    try {
      await klaviyo.trackStartedCheckout(email, cart);
      this.stats.emailEventsSent++;
    } catch (err) {
      this.logger.warn(`Marketing: Checkout tracking failed: ${err.message}`);
    }
  }

  /**
   * Called when product is viewed on storefront
   */
  async onProductViewed(email, product) {
    if (!email) return;
    try {
      await klaviyo.trackViewedProduct(email, product);
    } catch (err) {
      this.logger.warn(`Marketing: View tracking failed: ${err.message}`);
    }
  }

  /**
   * Called when someone signs up via the newsletter popup
   */
  async onNewsletterSignup(email, firstName = '', source = 'storefront_popup') {
    try {
      await klaviyo.upsertProfile({
        email,
        firstName,
        properties: {
          signup_source: source,
          signup_date: new Date().toISOString(),
        },
      });

      const mainListId = process.env.KLAVIYO_MAIN_LIST_ID;
      if (mainListId) {
        await klaviyo.addToList(mainListId, [email]);
      }

      this.stats.emailEventsSent++;
      this.stats.newsletterSignups++;
      this._addActivity('signup', `Newsletter signup: ${email}`, { email, source });

      // Alert OpenClaw
      await this._alertOpenClaw('marketing_newsletter_signup', {
        email,
        firstName,
        source,
        totalSignups: this.stats.newsletterSignups,
      });

      return { success: true };
    } catch (err) {
      this.logger.error(`Marketing: Signup failed: ${err.message}`);
      return { success: false };
    }
  }

  // ═══════════════════════════════════════
  // SOCIAL POSTING QUEUE
  // ═══════════════════════════════════════
  queueSocialPost(product) {
    this.pendingProducts.push(product);
    if (!this.isProcessing) this.processSocialQueue();
  }

  async processSocialQueue() {
    if (this.isProcessing || this.pendingProducts.length === 0) return;
    this.isProcessing = true;

    while (this.pendingProducts.length > 0) {
      const product = this.pendingProducts.shift();
      try {
        const results = await socialPoster.postProductToAll(product);
        const successCount = Object.values(results).filter(r => r?.success).length;
        this.stats.socialPostsSent += successCount;

        // Track each platform result in social history
        for (const [platform, result] of Object.entries(results)) {
          this._addSocialHistory({
            platform,
            productTitle: product.title,
            productId: product._id || product.id,
            status: result?.success ? 'success' : 'failed',
            error: result?.error || null,
          });
        }
        this._addActivity('social', `Posted ${product.title} to ${successCount} channels`, { productTitle: product.title, successCount });
      } catch (err) {
        this.logger.error(`Marketing: Social post failed: ${err.message}`);
        this._addActivity('social', `Social post failed: ${err.message}`, { error: err.message });
      }

      if (this.pendingProducts.length > 0) {
        await new Promise(r => setTimeout(r, this.postDelayMs));
      }
    }

    this.isProcessing = false;
  }

  // ═══════════════════════════════════════
  // MANUAL TRIGGERS (for OpenClaw commands)
  // ═══════════════════════════════════════

  /**
   * Force post a specific product to all social channels (skip rate limit)
   * Triggered by OpenClaw: POST /api/admin/marketing/post-now
   */
  async forcePostProduct(product) {
    // Reset rate limits for this forced post
    socialPoster.lastPostTime = {};
    const results = await socialPoster.postProductToAll(product);
    const successCount = Object.values(results).filter(r => r?.success).length;
    this.stats.socialPostsSent += successCount;
    return results;
  }

  /**
   * Send new arrivals email digest
   * Triggered by OpenClaw or cron
   */
  async sendNewArrivalsDigest(products, listId) {
    if (!products || products.length === 0) {
      return { sent: false, reason: 'no_products' };
    }

    const listIdToUse = listId || process.env.KLAVIYO_MAIN_LIST_ID;
    if (!listIdToUse) return { sent: false, reason: 'no_list_id' };

    try {
      const result = await klaviyo.createCampaign({
        name: `New Arrivals — ${new Date().toISOString().split('T')[0]}`,
        listId: listIdToUse,
        subject: `🔥 ${products.length} New Arrivals Just Dropped at XeriaCO`,
        previewText: `Check out ${products[0]?.title || 'our latest'} and more`,
      });

      await this._alertOpenClaw('marketing_digest_sent', {
        productCount: products.length,
        listId: listIdToUse,
        campaignId: result?.data?.id,
      });

      return { sent: true, campaignId: result?.data?.id };
    } catch (err) {
      this.logger.error(`Marketing: Digest failed: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  }

  // ═══════════════════════════════════════
  // CONTENT GENERATION PIPELINE
  // ═══════════════════════════════════════

  /**
   * Generate marketing content for products after pipeline completes.
   * Creates 1 image + 1 video + captions per product → goes to approval queue.
   */
  async runContentPipeline(products, pipelineRunId = null) {
    if (!contentGenerator.isEnabled) {
      this.logger.warn('ContentGenerator not enabled — skipping content pipeline');
      return { generated: 0, skipped: products.length, reason: 'ContentGenerator disabled' };
    }

    const MarketingContent = require('../models/MarketingContent');
    let generated = 0, failed = 0;

    for (const product of products) {
      try {
        // Skip if already has pending/approved content
        const existing = await MarketingContent.findOne({
          productId: product._id,
          status: { $in: ['generating', 'pending_approval', 'approved'] },
        });
        if (existing) {
          this.logger.info(`Content already exists for "${product.title}" — skipping`);
          continue;
        }

        // Create placeholder doc
        const contentDoc = new MarketingContent({
          productId: product._id,
          productTitle: product.title,
          productImage: product.featuredImage || product.images?.[0]?.url,
          productPrice: product.sellingPriceAud || product.price,
          productCategory: product.category,
          status: 'generating',
          pipelineRunId,
        });
        await contentDoc.save();

        // Generate everything
        this.logger.info(`Generating content for "${product.title}"...`);
        const content = await contentGenerator.generateForProduct(product);

        // Update doc with generated content
        contentDoc.caption = content.caption;
        contentDoc.image = content.image;
        contentDoc.generationCost = content.generationCost;
        contentDoc.status = 'pending_approval';
        await contentDoc.save();

        generated++;
        this.stats.contentGenerated++;
        this._addActivity('content_generated', `Content generated for "${product.title}" ($${content.generationCost.toFixed(2)})`, { productTitle: product.title, cost: content.generationCost });

        await this._alertOpenClaw('marketing_content_generated', {
          title: product.title,
          imageReady: content.image.status === 'ready',
          cost: content.generationCost,
        });

        // Rate limit — 2s between products
        if (products.indexOf(product) < products.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        failed++;
        this.logger.error(`Content generation failed for "${product.title}": ${err.message}`);
        // Mark as failed if doc was created
        try {
          await MarketingContent.updateOne(
            { productId: product._id, status: 'generating' },
            { status: 'failed', 'image.error': err.message }
          );
        } catch (e) {}
      }
    }

    this.logger.info(`Content pipeline: ${generated} generated, ${failed} failed, ${products.length - generated - failed} skipped`);
    return { generated, failed, total: products.length };
  }

  /**
   * Approve content — triggers auto-posting to all social channels
   */
  async approveContent(contentId) {
    const MarketingContent = require('../models/MarketingContent');
    const content = await MarketingContent.findById(contentId);
    if (!content) throw new Error('Content not found');
    if (content.status !== 'pending_approval') throw new Error(`Cannot approve content with status: ${content.status}`);

    content.status = 'approved';
    content.approvedAt = new Date();
    await content.save();
    this.stats.contentApproved++;

    // Auto-post to social channels
    try {
      const postResults = await socialPoster.postContentToAll({
        title: content.productTitle,
        price: content.productPrice,
        category: content.productCategory,
        image: content.image?.url || content.productImage,
        caption: content.caption,
      });

      const successCount = Object.values(postResults).filter(r => r?.success).length;
      content.status = 'posted';
      content.postedAt = new Date();
      content.postResults = postResults;
      await content.save();
      this.stats.socialPostsSent += successCount;

      this._addActivity('content_posted', `Posted "${content.productTitle}" to ${successCount} channels`, { productTitle: content.productTitle, successCount });
      return { success: true, posted: successCount, results: postResults };
    } catch (err) {
      this.logger.error(`Auto-post failed for "${content.productTitle}": ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Reject content
   */
  async rejectContent(contentId, reason = '') {
    const MarketingContent = require('../models/MarketingContent');
    const content = await MarketingContent.findById(contentId);
    if (!content) throw new Error('Content not found');

    content.status = 'rejected';
    content.rejectedAt = new Date();
    content.rejectionReason = reason;
    await content.save();
    this.stats.contentRejected++;
    this._addActivity('content_rejected', `Rejected content for "${content.productTitle}"${reason ? ': ' + reason : ''}`, { productTitle: content.productTitle });
    return { success: true };
  }

  /**
   * Regenerate content for a product (creates new entry)
   */
  async regenerateContent(contentId) {
    const MarketingContent = require('../models/MarketingContent');
    const { Product } = require('../models');
    const old = await MarketingContent.findById(contentId);
    if (!old) throw new Error('Content not found');

    // Mark old as rejected
    old.status = 'rejected';
    old.rejectionReason = 'Regenerated';
    await old.save();

    // Get the product
    const product = await Product.findById(old.productId).lean();
    if (!product) throw new Error('Product not found');

    // Generate fresh content
    const contentDoc = new MarketingContent({
      productId: product._id,
      productTitle: product.title,
      productImage: product.featuredImage || product.images?.[0]?.url,
      productPrice: product.sellingPriceAud || product.price,
      productCategory: product.category,
      status: 'generating',
      regenerationCount: (old.regenerationCount || 0) + 1,
      regeneratedFrom: old._id,
    });
    await contentDoc.save();

    try {
      const content = await contentGenerator.generateForProduct(product);
      contentDoc.caption = content.caption;
      contentDoc.image = content.image;
      contentDoc.video = content.video;
      contentDoc.generationCost = content.generationCost;
      contentDoc.status = 'pending_approval';
      await contentDoc.save();
      this.stats.contentGenerated++;
      this._addActivity('content_regenerated', `Regenerated content for "${product.title}"`, { productTitle: product.title });
      return contentDoc;
    } catch (err) {
      contentDoc.status = 'failed';
      contentDoc.image = { status: 'failed', error: err.message };
      await contentDoc.save();
      throw err;
    }
  }

  /**
   * Get content queue for dashboard
   */
  async getContentQueue(statusFilter = null, limit = 50) {
    const MarketingContent = require('../models/MarketingContent');
    const query = statusFilter ? { status: statusFilter } : {};
    return MarketingContent.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /**
   * Get content queue stats
   */
  async getContentQueueStats() {
    const MarketingContent = require('../models/MarketingContent');
    const [pending, approved, rejected, posted, generating, failed] = await Promise.all([
      MarketingContent.countDocuments({ status: 'pending_approval' }),
      MarketingContent.countDocuments({ status: 'approved' }),
      MarketingContent.countDocuments({ status: 'rejected' }),
      MarketingContent.countDocuments({ status: 'posted' }),
      MarketingContent.countDocuments({ status: 'generating' }),
      MarketingContent.countDocuments({ status: 'failed' }),
    ]);
    const totalCost = await MarketingContent.aggregate([{ $group: { _id: null, total: { $sum: '$generationCost' } } }]);
    return { pending, approved, rejected, posted, generating, failed, totalCost: totalCost[0]?.total || 0 };
  }

  // ═══════════════════════════════════════
  // STATUS (included in admin dashboard)
  // ═══════════════════════════════════════
  async getFullStatus() {
    const klaviyoStatus = await klaviyo.healthCheck();
    const socialStatus = socialPoster.getStatus();

    return {
      marketing: {
        stats: this.stats,
        pendingPosts: this.pendingProducts.length,
        isProcessing: this.isProcessing,
      },
      klaviyo: klaviyoStatus,
      social: socialStatus,
      channels: {
        email: klaviyoStatus.status === 'connected' ? 'active' : 'inactive',
        instagram: socialStatus.instagram,
        facebook: socialStatus.facebook,
        pinterest: socialStatus.pinterest,
      },
    };
  }

  /**
   * Summary for OpenClaw dashboard embed
   */
  getDashboardSummary() {
    return {
      socialPostsSent: this.stats.socialPostsSent,
      emailEventsSent: this.stats.emailEventsSent,
      productsMarketed: this.stats.productsMarketed,
      newsletterSignups: this.stats.newsletterSignups,
      ordersTracked: this.stats.ordersTracked,
      pendingPosts: this.pendingProducts.length,
      lastRun: this.stats.lastRun,
    };
  }

  // ═══════════════════════════════════════
  // ACTIVITY & HISTORY TRACKING
  // ═══════════════════════════════════════

  _addSocialHistory(entry) {
    this.socialHistory.unshift({ ...entry, timestamp: new Date().toISOString() });
    if (this.socialHistory.length > 100) this.socialHistory.pop();
  }

  _addActivity(type, message, data = {}) {
    this.recentActivity.unshift({
      type, message, ...data,
      timestamp: new Date().toISOString(),
    });
    if (this.recentActivity.length > 200) this.recentActivity.pop();
  }

  getSocialHistory(limit = 50) {
    return this.socialHistory.slice(0, limit);
  }

  getActivityFeed(limit = 50) {
    return this.recentActivity.slice(0, limit);
  }

  /**
   * Comprehensive dashboard data for marketing-dashboard.html
   */
  async getDashboardData() {
    const klaviyoStatus = await klaviyo.healthCheck();
    const socialStatus = socialPoster.getStatus();
    const uptime = Date.now() - new Date(this.startedAt).getTime();
    const contentQueueStats = await this.getContentQueueStats();
    const contentGenStatus = contentGenerator.getStatus();

    return {
      stats: {
        ...this.stats,
        pendingPosts: this.pendingProducts.length,
        isProcessing: this.isProcessing,
      },
      channels: {
        klaviyo: klaviyoStatus,
        instagram: { status: socialStatus.instagram },
        facebook: { status: socialStatus.facebook },
        pinterest: { status: socialStatus.pinterest },
        metaPixel: { status: process.env.NEXT_PUBLIC_META_PIXEL_ID ? 'configured' : 'disabled' },
        ga4: { status: process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID ? 'configured' : 'disabled' },
      },
      contentQueue: contentQueueStats,
      contentGenerator: contentGenStatus,
      socialHistory: this.socialHistory.slice(0, 50),
      activityFeed: this.recentActivity.slice(0, 100),
      uptime: {
        ms: uptime,
        human: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m`,
        startedAt: this.startedAt,
      },
    };
  }
}

module.exports = new MarketingOrchestrator();
