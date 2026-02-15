const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const config = require('../config');
const logger = require('./utils/logger');
const { apiLimiter, webhookLimiter, captureRawBody, requestLogger } = require('./middleware');
const { initCronJobs } = require('./cron');

// Route imports
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const webhookRoutes = require('./routes/webhooks');
const pipelineRoutes = require('./routes/pipeline');
const analyticsRoutes = require('./routes/analytics');
const woocommerceRoutes = require('./routes/woocommerce');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');
const checkoutRoutes = require('./routes/checkout');
const cartRoutes = require('./routes/cart');
const inventoryRoutes = require('./routes/inventory');
const automationRoutes = require('./routes/automation');
const marketplaceRoutes = require('./routes/marketplace');
const aiRoutes = require('./routes/ai');
const openclawRoutes = require('./routes/openclaw');
const storeRoutes = require('./routes/store');
const marketingRoutes = require('./routes/marketing');

// Service imports for marketing init
const marketing = require('./services/MarketingOrchestrator');
const clawdbotBridge = require('./services/ClawdbotBridge');
const aiContentGenerator = require('./services/AIContentGenerator');

const app = express();

// =======================================
// TRUST PROXY (Railway runs behind a reverse proxy)
// =======================================
app.set('trust proxy', 1);

// =======================================
// GLOBAL MIDDLEWARE
// =======================================

// Security
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173,https://xeriaco-frontend-production.up.railway.app,https://xeriaco-v9-production.up.railway.app').split(',').map(s => s.trim());
app.use(cors({
        origin: function (origin, callback) {
                    if (!origin) return callback(null, true);
                    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                                    return callback(null, true);
                    }
                    callback(null, true);
        },
        credentials: true,
}));

// Raw body capture for webhook HMAC verification
app.use('/api/webhooks', express.json({ verify: captureRawBody, limit: '5mb' }));

// JSON body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(requestLogger);

// =======================================
// ROUTES
// =======================================

// Public routes
app.use('/api', healthRoutes);

// Webhook routes
app.use('/api/webhooks/woocommerce', webhookLimiter, webhookRoutes);

// API routes (rate limited)
app.use('/api/store', apiLimiter, storeRoutes);
app.use('/api/products', apiLimiter, productRoutes);
app.use('/api/orders', apiLimiter, orderRoutes);
app.use('/api/pipeline', apiLimiter, pipelineRoutes);
app.use('/api/analytics', apiLimiter, analyticsRoutes);
app.use('/api/woocommerce', apiLimiter, woocommerceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', apiLimiter, chatRoutes);
app.use('/api/checkout', apiLimiter, checkoutRoutes);
app.use('/api/cart', apiLimiter, cartRoutes);
app.use('/api/inventory', apiLimiter, inventoryRoutes);
app.use('/api/automation', apiLimiter, automationRoutes);
app.use('/api/marketplace', apiLimiter, marketplaceRoutes);
app.use('/api/ai', apiLimiter, aiRoutes);
app.use('/api/openclaw', apiLimiter, openclawRoutes);
app.use('/api', marketingRoutes);

// =======================================
// PIPELINE TRIGGER WEBHOOK
// Allows external services to trigger the auto product generation pipeline
// Usage: POST /api/webhooks/pipeline/trigger with optional { secret: "...", type: "full" }
// =======================================
app.post('/api/webhooks/pipeline/trigger', webhookLimiter, async (req, res) => {
        try {
                    const { secret, type = 'full', maxProducts } = req.body || {};

            // Verify webhook secret (uses admin password as secret)
            const expectedSecret = process.env.PIPELINE_WEBHOOK_SECRET || config.admin.password;
                    if (secret && secret !== expectedSecret) {
                                    return res.status(401).json({ error: 'Invalid webhook secret' });
                    }

            const { PipelineRun } = require('./models');
                    const { v4: uuidv4 } = require('uuid');

            // Check if pipeline is already running
            const active = await PipelineRun.findOne({ status: { $in: ['queued', 'running'] } });
                    if (active) {
                                    return res.status(409).json({
                                                        error: 'Pipeline already running',
                                                        runId: active.runId,
                                                        status: active.status,
                                                        startedAt: active.startedAt,
                                    });
                    }

            // Create and start pipeline run
            const run = new PipelineRun({
                            runId: uuidv4(),
                            type,
                            status: 'running',
                            startedAt: new Date(),
                            triggeredBy: 'webhook',
                            config: { maxProducts: maxProducts || 50 },
            });
                    await run.save();

            // Execute in background
            const { executePipeline } = require('./routes/pipeline');
                    executePipeline(run).catch(err => {
                                    logger.error(`Pipeline webhook run failed: ${err.message}`, { runId: run.runId });
                    });

            logger.info(`Pipeline triggered via webhook: ${run.runId}`);
                    res.json({
                                    success: true,
                                    message: 'Pipeline started',
                                    runId: run.runId,
                                    type,
                    });
        } catch (err) {
                    logger.error('Pipeline webhook error', { error: err.message });
                    res.status(500).json({ error: err.message });
        }
});

// GET /api/webhooks/pipeline/status - Check pipeline status (no auth needed)
app.get('/api/webhooks/pipeline/status', apiLimiter, async (req, res) => {
        try {
                    const { PipelineRun } = require('./models');
                    const active = await PipelineRun.findOne({ status: { $in: ['queued', 'running'] } }).sort({ createdAt: -1 });
                    const lastCompleted = await PipelineRun.findOne({ status: 'completed' }).sort({ completedAt: -1 });

            res.json({
                            isRunning: !!active,
                            activeRun: active ? { runId: active.runId, status: active.status, startedAt: active.startedAt } : null,
                            lastCompleted: lastCompleted ? {
                                                runId: lastCompleted.runId,
                                                completedAt: lastCompleted.completedAt,
                                                results: lastCompleted.results,
                                                duration: `${Math.round(lastCompleted.durationMs / 1000)}s`,
                            } : null,
            });
        } catch (err) {
                    res.status(500).json({ error: err.message });
        }
});

// Store products endpoint for storefront
app.get('/api/store/products', apiLimiter, async (req, res) => {
        try {
                    const { Product } = require('./models');
                    const { category, search, limit: qLimit } = req.query;

            const filter = { isActive: true };
                    if (category && category !== 'all') filter.category = category;
                    if (search) filter.title = { $regex: search, $options: 'i' };

            const products = await Product.find(filter)
                        .sort({ 'analytics.purchases': -1, createdAt: -1 })
                        .limit(parseInt(qLimit) || 50)
                        .select('title slug description featuredImage images sellingPriceAud comparePriceAud category tags woocommerceProductId')
                        .lean();

            res.json({ products });
        } catch (err) {
                    res.status(500).json({ error: err.message });
        }
});

// Store single product endpoint
app.get('/api/store/products/:slug', apiLimiter, async (req, res) => {
        try {
                    const { Product } = require('./models');
                    const product = await Product.findOne({ slug: req.params.slug, isActive: true }).lean();
                    if (!product) return res.status(404).json({ error: 'Product not found' });
                    res.json({ product });
        } catch (err) {
                    res.status(500).json({ error: err.message });
        }
});

// Store categories endpoint
app.get('/api/store/categories', apiLimiter, async (req, res) => {
        try {
                    const { Product } = require('./models');
                    const categories = await Product.distinct('category', { isActive: true, 'pipeline.approved': true });
                    res.json(categories.filter(Boolean));
        } catch (err) {
                    res.status(500).json({ error: err.message });
        }
});

// =======================================
// AUTO-LIST WEBHOOK — Pipeline products auto-listed to storefront
// =======================================
app.post('/api/webhooks/auto-list', async (req, res) => {
    try {
        const { Product } = require('./models');
        // Find all products with isActive=true but no explicit listing
        const unlisted = await Product.find({
            isActive: true,
            sellingPriceAud: { $gt: 0 },
            $or: [
                { status: { $exists: false } },
                { status: null },
                { status: '' },
                { status: 'draft' },
                { status: 'discovered' },
                { status: 'analyzed' },
            ]
        });
        
        let listed = 0;
        for (const p of unlisted) {
            p.status = 'listed';
            p.shopifyStatus = 'active';
            p.isActive = true;
            if (!p.sellingPriceAud && p.aiAnalysis?.recommendedSellingPrice) {
                p.sellingPriceAud = p.aiAnalysis.recommendedSellingPrice;
            }
            if (!p.comparePriceAud && p.sellingPriceAud) {
                p.comparePriceAud = Math.round(p.sellingPriceAud * 1.35);
            }
            await p.save();
            listed++;
            
            // Trigger marketing for newly listed product
            try {
              await marketing.onProductLive(p);
            } catch (mktErr) {
              logger.warn(`Marketing hook failed for ${p.title}: ${mktErr.message}`);
            }
        }
        
        logger.info(`Auto-list webhook: ${listed} products listed for storefront`);
        res.json({ success: true, listed, total: unlisted.length });
    } catch (err) {
        logger.error('Auto-list webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

// =======================================
// MARKETING DASHBOARD
// =======================================
app.get('/admin/marketing-dashboard', (req, res) => {
    const dashPath = path.join(__dirname, '../marketing-dashboard.html');
    if (fs.existsSync(dashPath)) {
        res.sendFile(dashPath);
    } else {
        res.status(404).send('Marketing dashboard not found');
    }
});

// =======================================
// FRONTEND V9 — Combined React SPA
// =======================================
const path = require('path');
const fs = require('fs');
const publicDir = path.join(__dirname, '../public');

// Serve static assets from public/ (local files = fast)
if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { maxAge: '1d', index: false }));
}

// Auto-detect the V9 bundle from public/assets/
const assetsDir = path.join(publicDir, 'assets');
let bundleFile = 'index-DUF0v1J4.js'; // fallback
if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter(f => f.startsWith('index-') && f.endsWith('.js'));
    if (jsFiles.length > 0) bundleFile = jsFiles[0];
}
const V9_BUNDLE_CDN = `https://cdn.jsdelivr.net/gh/Diamondbanana420/xeriaco-frontend@main/dist/assets/${bundleFile}`;
const localBundle = path.join(assetsDir, bundleFile);
const V9_SRC = fs.existsSync(localBundle) ? `/assets/${bundleFile}` : V9_BUNDLE_CDN;

const V9_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>XeriaCo V9 — Command Center</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
  <style>body{margin:0;padding:0;background:#000}#v9-load{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;color:#6366f1;font-family:system-ui;font-size:14px;}</style>
</head>
<body>
  <div id="root"><div id="v9-load">⚡ Loading XeriaCo V9...</div></div>
  <script type="module" crossorigin src="${V9_SRC}"></script>
</body>
</html>`;

// Serve V9 for all non-API routes (SPA catch-all)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(V9_HTML);
});

// =======================================
// 404 HANDLER (for API routes only)
// =======================================
app.use((req, res) => {
        res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
        logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
        res.status(500).json({ error: 'Internal server error' });
});

// =======================================
// DATABASE & SERVER START
// =======================================
async function start() {
        try {
                    logger.info(`Connecting to MongoDB: ${config.mongo.uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
                    await mongoose.connect(config.mongo.uri, config.mongo.options);
                    logger.info('MongoDB connected');

            const { Product, Order } = require('./models');
                    await Product.createIndexes();
                    await Order.createIndexes();
                    logger.info('Database indexes ensured');

            // Initialize marketing automation
            marketing.init(logger, clawdbotBridge, aiContentGenerator);
            logger.info('Marketing system initialized');

            initCronJobs();

            const port = process.env.PORT || config.port;
                    app.listen(port, '0.0.0.0', () => {
                                    const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
                                        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                                                        : `http://localhost:${port}`;
                                    logger.info(`XeriaCO Backend running on port ${port}`);
                                    logger.info(`  Environment: ${config.env}`);
                                    logger.info(`  URL: ${railwayUrl}`);
                                    logger.info(`  Health: ${railwayUrl}/api/health`);
                                    logger.info(`  Admin: ${railwayUrl}/api/admin/dashboard`);
                                    logger.info(`  Pipeline Webhook: ${railwayUrl}/api/webhooks/pipeline/trigger`);
                    });
        } catch (err) {
                    logger.error('Failed to start server', { error: err.message });
                    process.exit(1);
        }
}

process.on('SIGTERM', async () => {
        logger.info('SIGTERM received. Shutting down...');
        await mongoose.connection.close();
        process.exit(0);
});

process.on('SIGINT', async () => {
        logger.info('SIGINT received. Shutting down...');
        await mongoose.connection.close();
        process.exit(0);
});

start();

module.exports = app;
