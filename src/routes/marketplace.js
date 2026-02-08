const express = require('express');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { Product } = require('../models');

const router = express.Router();

// ═══════════════════════════════════════
// MARKETPLACE SERVICE HELPERS
// ═══════════════════════════════════════

/**
 * Amazon SP-API Integration
 * Requires: AMAZON_SELLER_ID, AMAZON_MWS_AUTH_TOKEN, AMAZON_REFRESH_TOKEN
 * Uses Selling Partner API for listing creation
 */
class AmazonService {
    constructor() {
          this.baseUrl = process.env.AMAZON_SP_API_URL || 'https://sellingpartnerapi-na.amazon.com';
          this.sellerId = process.env.AMAZON_SELLER_ID;
          this.refreshToken = process.env.AMAZON_REFRESH_TOKEN;
          this.clientId = process.env.AMAZON_CLIENT_ID;
          this.clientSecret = process.env.AMAZON_CLIENT_SECRET;
          this.marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'A39IBJ37TRP1C6'; // AU
    }

  get isConfigured() {
        return !!(this.sellerId && this.refreshToken && this.clientId);
  }

  async getAccessToken() {
        const response = await axios.post('https://api.amazon.com/auth/o2/token', {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret,
        });
        return response.data.access_token;
  }

  async createListing(product) {
        if (!this.isConfigured) throw new Error('Amazon SP-API not configured');
        const token = await this.getAccessToken();

      const listing = {
              productType: 'PRODUCT',
              attributes: {
                        item_name: [{ value: product.title, marketplace_id: this.marketplaceId }],
                        bullet_point: (product.tags || []).slice(0, 5).map(t => ({
                                    value: t, marketplace_id: this.marketplaceId
                        })),
                        manufacturer: [{ value: 'XeriaCO', marketplace_id: this.marketplaceId }],
                        brand: [{ value: 'XeriaCO', marketplace_id: this.marketplaceId }],
                        externally_assigned_product_identifier: [{
                                    type: 'ean', value: product.ean || '0000000000000',
                                    marketplace_id: this.marketplaceId,
                        }],
                        list_price: [{ value: product.sellingPriceAud, currency: 'AUD', marketplace_id: this.marketplaceId }],
                        product_description: [{ value: (product.description || '').substring(0, 2000), marketplace_id: this.marketplaceId }],
                        main_product_image_locator: product.featuredImage ? [{ media_location: product.featuredImage, marketplace_id: this.marketplaceId }] : [],
                        fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 999, marketplace_id: this.marketplaceId }],
              },
      };

      const response = await axios.put(
              `${this.baseUrl}/listings/2021-08-01/items/${this.sellerId}/${product.slug}`,
              listing,
        {
                  headers: {
                              'x-amz-access-token': token,
                              'Content-Type': 'application/json',
                  },
                  params: { marketplaceIds: this.marketplaceId },
        }
            );

      return { platform: 'amazon', status: response.data.status, sku: product.slug, listingId: response.data.submissionId };
  }
}

/**
 * eBay Trading API Integration
 * Requires: EBAY_APP_ID, EBAY_CERT_ID, EBAY_DEV_ID, EBAY_USER_TOKEN
 * Uses eBay Inventory API (RESTful)
 */
class EbayService {
    constructor() {
          this.baseUrl = process.env.EBAY_API_URL || 'https://api.ebay.com';
          this.appId = process.env.EBAY_APP_ID;
          this.certId = process.env.EBAY_CERT_ID;
          this.userToken = process.env.EBAY_USER_TOKEN;
          this.refreshToken = process.env.EBAY_REFRESH_TOKEN;
    }

  get isConfigured() {
        return !!(this.appId && (this.userToken || this.refreshToken));
  }

  async getAccessToken() {
        if (this.userToken) return this.userToken;
        const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
        const response = await axios.post(`${this.baseUrl}/identity/v1/oauth2/token`, 
                                                `grant_type=refresh_token&refresh_token=${this.refreshToken}`,
                                          { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
                                              );
        return response.data.access_token;
  }

  async createListing(product) {
        if (!this.isConfigured) throw new Error('eBay API not configured');
        const token = await this.getAccessToken();

      // Create inventory item
      await axios.put(`${this.baseUrl}/sell/inventory/v1/inventory_item/${product.slug}`, {
              availability: { shipToLocationAvailability: { quantity: 999 } },
              condition: 'NEW',
              product: {
                        title: product.title,
                        description: (product.description || '').substring(0, 4000),
                        brand: 'XeriaCO',
                        imageUrls: product.images || (product.featuredImage ? [product.featuredImage] : []),
              },
      }, {
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });

      // Create offer
      const offer = await axios.post(`${this.baseUrl}/sell/inventory/v1/offer`, {
              sku: product.slug,
              marketplaceId: 'EBAY_AU',
              format: 'FIXED_PRICE',
              listingDescription: product.description || product.title,
              pricingSummary: { price: { value: String(product.sellingPriceAud), currency: 'AUD' } },
              categoryId: product.ebayCategoryId || '175673',
              listingPolicies: {
                        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
                        paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
                        returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
              },
      }, {
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });

      // Publish
      const publish = await axios.post(
              `${this.baseUrl}/sell/inventory/v1/offer/${offer.data.offerId}/publish`,
        {}, { headers: { Authorization: `Bearer ${token}` } }
            );

      return { platform: 'ebay', status: 'listed', sku: product.slug, listingId: publish.data.listingId };
  }
}

/**
 * Facebook Commerce (Meta Commerce Manager) Integration
 * Requires: FACEBOOK_ACCESS_TOKEN, FACEBOOK_CATALOG_ID
 * Uses Facebook Product Catalog API
 */
class FacebookService {
    constructor() {
          this.baseUrl = 'https://graph.facebook.com/v18.0';
          this.accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
          this.catalogId = process.env.FACEBOOK_CATALOG_ID;
    }

  get isConfigured() {
        return !!(this.accessToken && this.catalogId);
  }

  async createListing(product) {
        if (!this.isConfigured) throw new Error('Facebook Commerce not configured');

      const response = await axios.post(`${this.baseUrl}/${this.catalogId}/products`, {
              retailer_id: product.slug,
              name: product.title,
              description: (product.description || '').substring(0, 5000),
              availability: 'in stock',
              condition: 'new',
              price: `${Math.round(product.sellingPriceAud * 100)} AUD`,
              url: `https://xeriaco-frontend-production.up.railway.app/product/${product.slug}`,
              image_url: product.featuredImage || '',
              brand: 'XeriaCO',
              category: product.category || 'Other',
      }, {
              params: { access_token: this.accessToken },
      });

      return { platform: 'facebook', status: 'listed', sku: product.slug, listingId: response.data.id };
  }
}

/**
 * Temu Marketplace Integration
 * Requires: TEMU_APP_KEY, TEMU_APP_SECRET
 * Uses Temu Open Platform API
 * NOTE: Temu seller API access requires approved seller account
 */
class TemuService {
    constructor() {
          this.baseUrl = process.env.TEMU_API_URL || 'https://openapi.temubusiness.com';
          this.appKey = process.env.TEMU_APP_KEY;
          this.appSecret = process.env.TEMU_APP_SECRET;
          this.accessToken = process.env.TEMU_ACCESS_TOKEN;
    }

  get isConfigured() {
        return !!(this.appKey && this.appSecret && this.accessToken);
  }

  async createListing(product) {
        if (!this.isConfigured) throw new Error('Temu API not configured');

      const response = await axios.post(`${this.baseUrl}/openapi/router`, {
              type: 'bg.goods.add',
              access_token: this.accessToken,
              data: JSON.stringify({
                        goods_name: product.title,
                        cat_id: product.temuCategoryId || 0,
                        goods_desc: (product.description || '').substring(0, 3000),
                        market_price: Math.round(product.sellingPriceAud * 100),
                        goods_images: product.images || (product.featuredImage ? [product.featuredImage] : []),
                        sku_list: [{
                                    sku_price: Math.round(product.sellingPriceAud * 100),
                                    sku_stock: 999,
                                    outer_sku_id: product.slug,
                        }],
              }),
      }, {
              headers: { 'Content-Type': 'application/json' },
      });

      return { platform: 'temu', status: response.data.success ? 'listed' : 'failed', sku: product.slug, response: response.data };
  }
}

// Initialize services
const amazon = new AmazonService();
const ebay = new EbayService();
const facebook = new FacebookService();
const temu = new TemuService();

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

/**
 * GET /api/marketplace/status — Check which platforms are configured
 */
router.get('/status', (req, res) => {
    res.json({
          platforms: {
                  amazon: { configured: amazon.isConfigured, name: 'Amazon AU' },
                  ebay: { configured: ebay.isConfigured, name: 'eBay AU' },
                  facebook: { configured: facebook.isConfigured, name: 'Facebook/Instagram Shop' },
                  temu: { configured: temu.isConfigured, name: 'Temu' },
                  woocommerce: { configured: !!(config.woocommerce?.url), name: 'WooCommerce' },
          },
    });
});

/**
 * POST /api/marketplace/list — List a product on specified platforms
 * Body: { productId or slug, platforms: ['amazon','ebay','facebook','temu'] }
 */
router.post('/list', async (req, res) => {
    try {
          const { productId, slug, platforms = ['amazon', 'ebay', 'facebook', 'temu'] } = req.body;

      const product = productId
            ? await Product.findById(productId).lean()
              : await Product.findOne({ slug }).lean();

      if (!product) return res.status(404).json({ error: 'Product not found' });

      const results = [];
          const serviceMap = { amazon, ebay, facebook, temu };

      for (const platform of platforms) {
              const service = serviceMap[platform];
              if (!service) {
                        results.push({ platform, status: 'error', error: 'Unknown platform' });
                        continue;
              }
              if (!service.isConfigured) {
                        results.push({ platform, status: 'skipped', error: 'Not configured' });
                        continue;
              }
              try {
                        const result = await service.createListing(product);
                        results.push(result);

                // Update product with marketplace listing info
                await Product.findByIdAndUpdate(product._id, {
                            $set: { [`marketplace.${platform}`]: { listed: true, listingId: result.listingId, listedAt: new Date() } },
                });

                logger.info(`Listed ${product.slug} on ${platform}: ${result.listingId}`);
              } catch (err) {
                        results.push({ platform, status: 'error', error: err.message });
                        logger.error(`Failed to list ${product.slug} on ${platform}`, { error: err.message });
              }
      }

      res.json({ product: product.slug, results });
    } catch (err) {
          logger.error('Marketplace list error', { error: err.message });
          res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/marketplace/sync-all — Sync all approved products to all platforms
 * Useful for bulk initial listing
 */
router.post('/sync-all', async (req, res) => {
    try {
          const { platforms = ['amazon', 'ebay', 'facebook', 'temu'], limit = 50 } = req.body;

      const products = await Product.find({
              isActive: true,
              'pipeline.approved': true,
      }).limit(limit).lean();

      const summary = { total: products.length, success: 0, failed: 0, skipped: 0, details: [] };

      for (const product of products) {
              const serviceMap = { amazon, ebay, facebook, temu };

            for (const platform of platforms) {
                      const service = serviceMap[platform];
                      if (!service?.isConfigured) { summary.skipped++; continue; }

                // Skip if already listed
                if (product.marketplace?.[platform]?.listed) { summary.skipped++; continue; }

                try {
                            const result = await service.createListing(product);
                            await Product.findByIdAndUpdate(product._id, {
                                          $set: { [`marketplace.${platform}`]: { listed: true, listingId: result.listingId, listedAt: new Date() } },
                            });
                            summary.success++;
                            summary.details.push({ slug: product.slug, platform, status: 'listed' });
                } catch (err) {
                            summary.failed++;
                            summary.details.push({ slug: product.slug, platform, status: 'error', error: err.message });
                }
            }
      }

      logger.info(`Marketplace sync: ${summary.success} listed, ${summary.failed} failed, ${summary.skipped} skipped`);
          res.json(summary);
    } catch (err) {
          logger.error('Marketplace sync error', { error: err.message });
          res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/marketplace/update-price — Sync price changes across platforms
 * Body: { slug, newPriceAud }
 */
router.post('/update-price', async (req, res) => {
    try {
          const { slug, newPriceAud } = req.body;
          if (!slug || !newPriceAud) return res.status(400).json({ error: 'slug and newPriceAud required' });

      const product = await Product.findOne({ slug }).lean();
          if (!product) return res.status(404).json({ error: 'Product not found' });

      // Update local DB
      await Product.findByIdAndUpdate(product._id, { sellingPriceAud: newPriceAud });

      // TODO: Implement per-platform price update APIs
      // Each platform has different price update endpoints
      const results = [];
          const platforms = ['amazon', 'ebay', 'facebook', 'temu'];
          for (const platform of platforms) {
                  if (product.marketplace?.[platform]?.listed) {
                            results.push({ platform, status: 'pending', message: 'Price update queued' });
                  }
          }

      res.json({ slug, newPriceAud, results });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

module.exports = router;
