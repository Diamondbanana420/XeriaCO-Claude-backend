/**
 * Marketing API Routes
 * 
 * ADMIN routes (OpenClaw calls these with X-Admin-Password or X-API-Key):
 *   GET  /api/admin/marketing/status     — Full marketing system status
 *   POST /api/admin/marketing/post-now   — Force post a product to all social (skip rate limit)
 *   POST /api/admin/marketing/post-all   — Post a product (respects rate limits)
 *   POST /api/admin/marketing/digest     — Send new arrivals email blast
 *   POST /api/admin/marketing/test       — Test all channel connections
 *   GET  /api/admin/marketing/summary    — Quick stats for dashboard embed
 *   GET  /api/admin/marketing/dashboard  — Full dashboard data (for marketing-dashboard.html)
 *   GET  /api/admin/marketing/social-history — Social post history
 *   GET  /api/admin/marketing/activity   — Activity feed
 * 
 * PUBLIC routes (storefront calls these — no auth needed):
 *   POST /api/store/track/view           — Track product view
 *   POST /api/store/track/checkout       — Track checkout started
 *   POST /api/store/newsletter           — Newsletter signup
 */

const express = require('express');
const router = express.Router();
const marketing = require('../services/MarketingOrchestrator');
const socialPoster = require('../services/SocialPoster');
const klaviyo = require('../services/KlaviyoService');

// Auth middleware — same pattern as admin routes
function clawdbotAuth(req, res, next) {
  const adminPass = req.headers['x-admin-password'] || req.query.password;
  const apiKey = req.headers['x-api-key'];
  const config = require('../../config');

  if (adminPass === config.admin.password || apiKey === config.clawdbot.apiKey) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ═══════════════════════════════════════
// ADMIN ROUTES — OpenClaw controlled
// ═══════════════════════════════════════

// Full marketing status
router.get('/admin/marketing/status', clawdbotAuth, async (req, res) => {
  try {
    const status = await marketing.getFullStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick stats for dashboard
router.get('/admin/marketing/summary', clawdbotAuth, (req, res) => {
  res.json(marketing.getDashboardSummary());
});

// Full dashboard data (for marketing-dashboard.html)
router.get('/admin/marketing/dashboard', clawdbotAuth, async (req, res) => {
  try {
    const data = await marketing.getDashboardData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Social post history
router.get('/admin/marketing/social-history', clawdbotAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(marketing.getSocialHistory(limit));
});

// Activity feed
router.get('/admin/marketing/activity', clawdbotAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(marketing.getActivityFeed(limit));
});

// Force post product to social (skips rate limits) — for OpenClaw manual trigger
router.post('/admin/marketing/post-now', clawdbotAuth, async (req, res) => {
  try {
    const { productId, product } = req.body;
    let targetProduct = product;

    if (productId && !targetProduct) {
      try {
        const { Product } = require('../models');
        targetProduct = await Product.findById(productId).lean();
      } catch (e) {
        // Models might not be available in all setups
      }
      if (!targetProduct) return res.status(404).json({ error: 'Product not found' });
    }

    if (!targetProduct) return res.status(400).json({ error: 'Provide productId or product object' });

    const results = await marketing.forcePostProduct(targetProduct);
    res.json({ success: true, forced: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post product respecting rate limits
router.post('/admin/marketing/post-all', clawdbotAuth, async (req, res) => {
  try {
    const { productId, product } = req.body;
    let targetProduct = product;

    if (productId && !targetProduct) {
      try {
        const { Product } = require('../models');
        targetProduct = await Product.findById(productId).lean();
      } catch (e) {}
      if (!targetProduct) return res.status(404).json({ error: 'Product not found' });
    }

    if (!targetProduct) return res.status(400).json({ error: 'Provide productId or product object' });

    const results = await socialPoster.postProductToAll(targetProduct);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send new arrivals email digest
router.post('/admin/marketing/digest', clawdbotAuth, async (req, res) => {
  try {
    const { listId, days = 7 } = req.body;
    let newProducts = [];

    try {
      const { Product } = require('../models');
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      newProducts = await Product.find({
        status: 'active',
        createdAt: { $gte: since },
      }).lean();
    } catch (e) {
      // If Product model not available, accept products in body
      newProducts = req.body.products || [];
    }

    const result = await marketing.sendNewArrivalsDigest(newProducts, listId);
    res.json({ success: true, productCount: newProducts.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test all marketing channel connections
router.post('/admin/marketing/test', clawdbotAuth, async (req, res) => {
  try {
    const results = {};

    results.klaviyo = await klaviyo.healthCheck();
    results.social = socialPoster.getStatus();

    if (results.klaviyo.status === 'connected') {
      try {
        await klaviyo.trackEvent('test@xeriaco.com.au', 'Marketing Test', {
          timestamp: new Date().toISOString(),
        });
        results.klaviyoEvents = 'working';
      } catch (err) {
        results.klaviyoEvents = `failed: ${err.message}`;
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// CONTENT QUEUE ROUTES — Approval workflow
// ═══════════════════════════════════════

// Get content queue (pending approval, with filters)
router.get('/admin/marketing/content-queue', clawdbotAuth, async (req, res) => {
  try {
    const status = req.query.status || null;
    const limit = parseInt(req.query.limit) || 50;
    const queue = await marketing.getContentQueue(status, limit);
    res.json({ content: queue, total: queue.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get content queue stats
router.get('/admin/marketing/content-stats', clawdbotAuth, async (req, res) => {
  try {
    const stats = await marketing.getContentQueueStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve content → auto-posts to social
router.post('/admin/marketing/content/:id/approve', clawdbotAuth, async (req, res) => {
  try {
    const result = await marketing.approveContent(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject content
router.post('/admin/marketing/content/:id/reject', clawdbotAuth, async (req, res) => {
  try {
    const result = await marketing.rejectContent(req.params.id, req.body.reason || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Regenerate content
router.post('/admin/marketing/content/:id/regenerate', clawdbotAuth, async (req, res) => {
  try {
    const newContent = await marketing.regenerateContent(req.params.id);
    res.json({ success: true, content: newContent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger content generation for specific product
router.post('/admin/marketing/generate', clawdbotAuth, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId required' });
    
    const { Product } = require('../models');
    const product = await Product.findById(productId).lean();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const result = await marketing.runContentPipeline([product], 'manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// PUBLIC ROUTES — Storefront tracking
// ═══════════════════════════════════════

// Track product view
router.post('/store/track/view', async (req, res) => {
  try {
    const { email, productId, title, price, image, category } = req.body;
    if (email) {
      await marketing.onProductViewed(email, {
        _id: productId, title, sellingPriceAud: price, featuredImage: image, category,
      });
    }
    res.json({ tracked: true });
  } catch (err) {
    res.json({ tracked: false });
  }
});

// Track checkout started
router.post('/store/track/checkout', async (req, res) => {
  try {
    const { email, items, totalPrice, checkoutUrl } = req.body;
    if (email) {
      await marketing.onCheckoutStarted(email, {
        items: items || [], totalPrice: totalPrice || 0, checkoutUrl: checkoutUrl || '',
      });
    }
    res.json({ tracked: true });
  } catch (err) {
    res.json({ tracked: false });
  }
});

// Newsletter signup
router.post('/store/newsletter', async (req, res) => {
  try {
    const { email, firstName, source } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const result = await marketing.onNewsletterSignup(email, firstName || '', source || 'storefront_popup');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;

// Debug: check content generator config
router.get('/admin/marketing/content-debug', clawdbotAuth, (req, res) => {
  const contentGenerator = require('../services/ContentGenerator');
  res.json({
    falKeySet: !!process.env.FAL_KEY,
    falApiKeySet: !!process.env.FAL_API_KEY,
    falKeyPrefix: (process.env.FAL_KEY || '').substring(0, 8) || 'NOT SET',
    falApiKeyPrefix: (process.env.FAL_API_KEY || '').substring(0, 8) || 'NOT SET',
    generatorStatus: contentGenerator.getStatus(),
    envKeysWithFal: Object.keys(process.env).filter(k => k.toLowerCase().includes('fal')),
  });
});
