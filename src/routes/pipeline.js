const express = require('express');
const router = express.Router();
const { PipelineRun, Product } = require('../models');
const pricingEngine = require('../services/PricingEngine');
const wooCommerceService = require('../services/WooCommerceService');
const clawdbotBridge = require('../services/ClawdbotBridge');
const trendScout = require('../services/TrendScout');
const supplierSourcer = require('../services/SupplierSourcer');
const aiContent = require('../services/AIContentGenerator');
const competitorScraper = require('../services/CompetitorScraper');
const airtableSync = require('../services/AirtableSync');
const n8nIntegration = require('../services/N8nIntegration');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// GET /api/pipeline/status - Current pipeline status
router.get('/status', async (req, res) => {
    try {
          const activeRun = await PipelineRun.findOne({ status: { $in: ['queued', 'running'] } }).sort({ createdAt: -1 });
          const lastCompleted = await PipelineRun.findOne({ status: 'completed' }).sort({ completedAt: -1 });

      res.json({
              isRunning: !!activeRun,
              activeRun: activeRun || null,
              lastCompleted: lastCompleted ? {
                        runId: lastCompleted.runId,
                        type: lastCompleted.type,
                        completedAt: lastCompleted.completedAt,
                        results: lastCompleted.results,
                        duration: `${Math.round(lastCompleted.durationMs / 1000)}s`,
              } : null,
      });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// GET /api/pipeline/history - Pipeline run history
router.get('/history', async (req, res) => {
    try {
          const { limit = 10 } = req.query;
          const runs = await PipelineRun.find()
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .select('runId type status startedAt completedAt durationMs results triggeredBy');
          res.json(runs);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// POST /api/pipeline/run - Trigger a manual pipeline run
router.post('/run', async (req, res) => {
    try {
          const { type = 'full' } = req.body;

      // Check for already running
      const active = await PipelineRun.findOne({ status: { $in: ['queued', 'running'] } });
          if (active) {
                  return res.status(409).json({ error: 'Pipeline already running', runId: active.runId });
          }

      const run = new PipelineRun({
              runId: uuidv4(),
              type,
              status: 'running',
              startedAt: new Date(),
              triggeredBy: 'manual',
      });
          await run.save();

      // Run in background
      executePipeline(run).catch(err => {
              logger.error('Pipeline run failed: ${err.message}', { runId: run.runId });
      });

      res.json({ message: 'Pipeline started', runId: run.runId });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// POST /api/pipeline/price-update - Recalculate all product prices
router.post('/price-update', async (req, res) => {
    try {
          const products = await Product.find({ isActive: true });
          let updated = 0;

      for (const product of products) {
              try {
                        const pricing = pricingEngine.calculatePrice(product);
                        product.pricing = { ...product.pricing, ...pricing };
                        product.sellingPriceAud = pricing.sellingPriceAud;
                        product.comparePriceAud = pricing.comparePriceAud;
                        product.profitMarginPercent = pricing.profitMarginPercent;

                // Update WooCommerce if synced and price changed
                if (product.woocommerceProductId && Math.abs(product.pricing.sellingPriceAud - pricing.sellingPriceAud) > 0.01) {
                            try {
                                          await wooCommerceService.updateProduct(product.woocommerceProductId, {
                                                          regular_price: String(pricing.comparePriceAud || pricing.sellingPriceAud),
                                                          sale_price: String(pricing.sellingPriceAud)
                                          });
                            } catch (err) {
                                          logger.warn(`Failed to update WooCommerce price for ${product.title}: ${err.message}`);
                            }
                }
                        await product.save();
                        updated++;
              } catch (err) {
                        logger.warn(`Price update failed for ${product.title}: ${err.message}`);
              }
      }

      res.json({ updated, total: products.length });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

/**
 * Background pipeline execution - FULL AUTONOMOUS PIPELINE
 * Discovery -> Supplier Sourcing -> AI Content -> Pricing -> Validation -> WooCommerce Listing -> Airtable Sync
 */
async function executePipeline(run) {
    const startTime = Date.now();
    try {
          run.status = 'running';
          run.startedAt = new Date();
          run.logs.push({ level: 'info', message: 'Pipeline started', timestamp: new Date() });
          await run.save();

      // ================================
      // Stage 1: TREND DISCOVERY
      // ================================
      run.logs.push({ level: 'info', message: 'Stage 1: TrendScout - discovering products', timestamp: new Date() });
          await run.save();

      let discoveredProducts = [];
          try {
                  discoveredProducts = await trendScout.scan();
          } catch (err) {
                  run.results.errors.push({ stage: 'trend_discovery', message: err.message, timestamp: new Date() });
          }

      run.results.productsDiscovered = discoveredProducts.length;
          run.logs.push({ level: 'info', message: `Stage 1 complete: ${discoveredProducts.length} products discovered`, timestamp: new Date() });
          await run.save();

      // Save discovered products to DB
      for (const product of discoveredProducts) {
              try {
                        const newProduct = new Product({
                                    title: product.name,
                                    source: product.source,
                                    costUsd: product.costUsd,
                                    costAud: product.costAud || product.costUsd,
                                    supplier: product.supplier,
                                    images: product.image ? [{ url: product.image, alt: product.name }] : [],
                                    category: product.category,
                                    isActive: true,
                                    pipeline: {
                                                  discoveredAt: new Date(),
                                                  source: product.source,
                                                  researchScore: product.trendScore || 0,
                                    }
                        });
                        await newProduct.save();
              } catch (err) {
                        logger.warn(`Failed to save product ${product.name}: ${err.message}`);
              }
      }

      // ================================
      // Stage 2: SUPPLIER SOURCING
      // ================================
      run.logs.push({ level: 'info', message: 'Stage 2: Supplier sourcing', timestamp: new Date() });
          await run.save();

      let sourcingResults = { sourced: 0 };
          try {
                  sourcingResults = await supplierSourcer.autoSourceProducts(run.config?.maxProducts || 20);
          } catch (err) {
                  run.results.errors.push({ stage: 'supplier_sourcing', message: err.message, timestamp: new Date() });
          }
          run.logs.push({ level: 'info', message: `Stage 2 complete: ${sourcingResults.sourced} products sourced`, timestamp: new Date() });
          await run.save();

      // ================================
      // Stage 3: AI CONTENT GENERATION
      // ================================
      run.logs.push({ level: 'info', message: 'Stage 3: AI content generation', timestamp: new Date() });
          await run.save();

      let contentResults = { enriched: 0 };
          try {
                  contentResults = await aiContent.bulkEnrich(run.config?.maxProducts || 15);
          } catch (err) {
                  run.results.errors.push({ stage: 'ai_content', message: err.message, timestamp: new Date() });
          }
          run.logs.push({ level: 'info', message: `Stage 3 complete: ${contentResults.enriched} products enriched with AI content`, timestamp: new Date() });
          await run.save();

      // ================================
      // Stage 4: VALIDATION & SCORING
      // ================================
      run.logs.push({ level: 'info', message: 'Stage 4: Validation & auto-approval', timestamp: new Date() });
          await run.save();

      const candidates = await Product.find({
              'pipeline.approved': false,
              'pipeline.rejectionReason': '',
              isActive: true,
              costUsd: { $gt: 0 },
      }).limit(run.config?.maxProducts || 50);

      let validated = 0;
          let rejected = 0;

      for (const product of candidates) {
              // Must have cost data
            if (product.costUsd <= 0) {
                      product.pipeline.rejectionReason = 'No cost data';
                      await product.save();
                      rejected++;
                      continue;
            }

            // Must have minimum profit
            if (product.profitMarginPercent < 20) {
                      product.pipeline.rejectionReason = `Low margin: ${product.profitMarginPercent.toFixed(1)}%`;
                      await product.save();
                      rejected++;
                      continue;
            }

            // Must have supplier
            if (!product.supplier?.url) {
                      product.pipeline.rejectionReason = 'No supplier found';
                      await product.save();
                      rejected++;
                      continue;
            }

            // Auto-approve if score >= threshold
            if (product.pipeline.researchScore >= 30 || product.profitMarginPercent >= 35) {
                      product.pipeline.approved = true;
                      product.pipeline.approvedAt = new Date();
                      product.pipeline.runId = run.runId;
                      await product.save();
                      validated++;
            } else {
                      rejected++;
            }
      }

      run.results.productsValidated = validated;
          run.results.productsRejected = rejected;
          run.logs.push({ level: 'info', message: `Stage 4 complete: ${validated} approved, ${rejected} rejected`, timestamp: new Date() });
          await run.save();

      // ================================
      // Stage 5: WOOCOMMERCE LISTING
      // ================================
      run.logs.push({ level: 'info', message: 'Stage 5: WooCommerce listing', timestamp: new Date() });
          await run.save();

      const approvedProducts = await Product.find({
              'pipeline.approved': true,
              woocommerceProductId: { $exists: false },
              isActive: true,
      }).limit(run.config?.maxProducts || 20);

      let listed = 0;
          for (const product of approvedProducts) {
                  try {
                            const wooProduct = await wooCommerceService.createProduct({
                                        name: product.title,
                                        type: 'simple',
                                        regular_price: String(product.comparePriceAud || product.sellingPriceAud || '0'),
                                        sale_price: String(product.sellingPriceAud || '0'),
                                        description: product.description || product.aiContent?.description || '',
                                        short_description: product.aiContent?.shortDescription || product.title,
                                        categories: product.category ? [{ name: product.category }] : [],
                                        images: (product.images || []).map(img => ({ src: img.url, alt: img.alt || product.title })),
                                        status: 'publish',
                                        manage_stock: false,
                                        meta_data: [
                                          { key: '_supplier_url', value: product.supplier?.url || '' },
                                          { key: '_cost_aud', value: String(product.costAud || 0) },
                                          { key: '_pipeline_run_id', value: run.runId },
                                                    ]
                            });

                    product.woocommerceProductId = String(wooProduct.id);
                            product.woocommerceSlug = wooProduct.slug || '';
                            product.lastSyncedToWooCommerce = new Date();
                            await product.save();
                            listed++;
                  } catch (err) {
                            run.results.errors.push({ stage: 'woocommerce_listing', message: `${product.title}: ${err.message}`, timestamp: new Date() });
                  }
          }

      run.results.productsListed = listed;
          run.logs.push({ level: 'info', message: `Stage 5 complete: ${listed} products listed on WooCommerce`, timestamp: new Date() });
          await run.save();

      // ================================
      // Stage 6: AIRTABLE SYNC
      // ================================
      run.logs.push({ level: 'info', message: 'Stage 6: Syncing to Airtable', timestamp: new Date() });
          await run.save();

      try {
              await airtableSync.bulkSyncProducts(50);
      } catch (err) {
              run.results.errors.push({ stage: 'airtable_sync', message: err.message, timestamp: new Date() });
      }

      // ================================
      // COMPLETE
      // ================================
      run.status = 'completed';
          run.completedAt = new Date();
          run.durationMs = Date.now() - startTime;
          run.logs.push({ level: 'info', message: `Pipeline completed in ${Math.round(run.durationMs / 1000)}s`, timestamp: new Date() });
          await run.save();

      // ================================
      // AUTO-LIST: Mark discovered products as listed for storefront
      // ================================
      try {
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
          let autoListed = 0;
          for (const p of unlisted) {
              p.status = 'listed';
              p.shopifyStatus = 'active';
              if (!p.comparePriceAud && p.sellingPriceAud) {
                  p.comparePriceAud = Math.round(p.sellingPriceAud * 1.35);
              }
              await p.save();
              autoListed++;
          }
          run.results.productsAutoListed = autoListed;
          await run.save();
          logger.info(`Auto-listed ${autoListed} products for storefront`);
      } catch (autoErr) {
          logger.warn('Auto-list failed', { error: autoErr.message });
      }

      // Notify via channels
      try {
              await clawdbotBridge.notify('pipeline_complete', {
                        runId: run.runId,
                        duration: `${Math.round(run.durationMs / 1000)}s`,
                        discovered: run.results.productsDiscovered,
                        listed: run.results.productsListed,
                        errors: run.results.errors.length,
              });
      } catch (err) {
              logger.warn('Pipeline notification failed', { error: err.message });
      }

      logger.info('Pipeline completed', {
              runId: run.runId,
              duration: `${Math.round(run.durationMs / 1000)}s`,
              results: run.results,
      });

    } catch (err) {
          run.status = 'failed';
          run.completedAt = new Date();
          run.durationMs = Date.now() - startTime;
          run.logs.push({ level: 'error', message: `Pipeline failed: ${err.message}`, timestamp: new Date() });
          await run.save();
          throw err;
    }
}

// POST /api/pipeline/supplier-search - Manual supplier search
router.post('/supplier-search', async (req, res) => {
    try {
          const results = await supplierSourcer.autoSourceProducts(req.body.limit || 10);
          res.json(results);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// POST /api/pipeline/airtable-sync - Manual Airtable sync
router.post('/airtable-sync', async (req, res) => {
    try {
          const [products, orders, pull] = await Promise.allSettled([
                  airtableSync.bulkSyncProducts(req.body.limit || 50),
                  airtableSync.bulkSyncOrders(req.body.limit || 50),
                  airtableSync.pullProductUpdatesFromAirtable(),
                ]);
          res.json({
                  productsPushed: products.value || products.reason?.message,
                  ordersPushed: orders.value || orders.reason?.message,
                  productsPulled: pull.value || pull.reason?.message,
          });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// GET /api/pipeline/airtable-status - Airtable connection status
router.get('/airtable-status', async (req, res) => {
    try {
          const status = await airtableSync.testConnection();
          res.json(status);
    } catch (err) {
          res.json({ connected: false, error: err.message });
    }
});

module.exports = router;
module.exports.executePipeline = executePipeline;
