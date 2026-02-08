const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { Product } = require('../models');

class TrendScout {
    constructor() {
          this.enabled = config.trendScout.enabled;
          this.maxProducts = config.trendScout.maxProductsPerScan;
          this.minScore = config.trendScout.minTrendScore;
          this.categories = config.trendScout.categories;
          this.cjApiUrl = 'https://developers.cjdropshipping.com/api2.0/v1';
          this.cjAccessToken = process.env.CJ_ACCESS_TOKEN || '';
    }

  async sleep(ms) {
        return new Promise(r => setTimeout(r, ms || 1500));
  }

  // ============================================
  // CJ DROPSHIPPING API - Product Discovery
  // ============================================

  async refreshCJToken() {
        try {
                const email = process.env.CJ_EMAIL;
                const password = process.env.CJ_PASSWORD;
                if (!email || !password) {
                          logger.warn('CJ email/password not set, using existing token');
                          return this.cjAccessToken;
                }
                const res = await axios.post(`${this.cjApiUrl}/authentication/getAccessToken`, {
                          email,
                          password
                });
                if (res.data && res.data.data && res.data.data.accessToken) {
                          this.cjAccessToken = res.data.data.accessToken;
                          logger.info('CJ access token refreshed');
                }
                return this.cjAccessToken;
        } catch (err) {
                logger.warn('CJ token refresh failed, using existing token', { error: err.message });
                return this.cjAccessToken;
        }
  }

  async fetchCJProducts(options = {}) {
        const products = [];
        try {
                if (!this.cjAccessToken) {
                          logger.error('CJ_ACCESS_TOKEN not configured');
                          return products;
                }

          const params = {
                    pageNum: options.page || 1,
                    pageSize: options.size || 20,
                    productFlag: options.productFlag !== undefined ? options.productFlag : 0,
                    countryCode: 'AU',
                    currency: 'AUD',
                    sort: 'listedNum',
                    orderBy: 'DESC'
          };

          if (options.keyword) params.keyWord = options.keyword;
                if (options.categoryId) params.categoryId = options.categoryId;
                if (options.minPrice) params.startSellPrice = options.minPrice;
                if (options.maxPrice) params.endSellPrice = options.maxPrice;

          logger.info('Fetching CJ products', { params });

          const res = await axios.get(`${this.cjApiUrl}/product/listV2`, {
                    headers: {
                                'CJ-Access-Token': this.cjAccessToken,
                                'Content-Type': 'application/json'
                    },
                    params
          });

          if (res.data && res.data.code === 200 && res.data.data && res.data.data.list) {
                    const items = res.data.data.list;
                    logger.info(`CJ API returned ${items.length} products`);

                  for (const item of items) {
                              products.push({
                                            name: item.nameEn || item.productNameEn || 'Unknown Product',
                                            source: 'cj_dropshipping',
                                            externalId: item.pid || item.id,
                                            sku: item.productSku || item.sku || '',
                                            image: item.bigImage || item.productImage || '',
                                            costUsd: parseFloat(item.sellPrice) || 0,
                                            costAud: parseFloat(item.sellPrice) || 0,
                                            orders: parseInt(item.listedNum) || 0,
                                            rating: 4.0,
                                            url: `https://cjdropshipping.com/product/${item.pid || item.id}`,
                                            category: item.threeCategoryName || item.categoryName || 'General',
                                            categoryId: item.categoryId || '',
                                            supplier: {
                                                            name: 'CJ Dropshipping',
                                                            platform: 'cjdropshipping',
                                                            id: item.pid || item.id,
                                                            url: `https://cjdropshipping.com/product/${item.pid || item.id}`,
                                                            shipsFrom: 'CN',
                                                            processingTime: '1-3 days',
                                                            shippingTime: '7-15 days'
                                            }
                              });
                  }
          } else {
                    const errMsg = res.data ? res.data.message || JSON.stringify(res.data) : 'Empty response';
                    logger.warn('CJ API response issue', { message: errMsg });
          }
        } catch (err) {
                logger.error('CJ API fetch failed', { error: err.message });
                if (err.response && err.response.status === 401) {
                          logger.info('CJ token may be expired, attempting refresh...');
                          await this.refreshCJToken();
                }
        }
        return products;
  }

  // ============================================
  // BRAVE SEARCH — AliDrop Trend Scraping
  // ============================================

  async scrapeAliDropTrends() {
    const products = [];
    if (!config.braveSearch?.apiKey) {
      logger.warn('TrendScout: Brave Search API key not configured');
      return products;
    }

    const queries = ['trending dropshipping products 2026', 'winning products aliexpress'];

    for (const query of queries) {
      try {
        const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
          params: { q: query, count: 10 },
          headers: { 'X-Subscription-Token': config.braveSearch.apiKey },
        });

        const results = res.data?.web?.results || [];
        results.forEach((result, idx) => {
          const name = result.title?.replace(/[|\-–—].*$/, '').trim();
          if (name && name.length > 5) {
            products.push({
              name,
              source: 'brave_search',
              externalId: `brave_${Buffer.from(name).toString('base64').substring(0, 20)}`,
              category: this.inferCategory(name, result.description || ''),
              trendScore: Math.max(30, 60 - idx * 3),
              costUsd: 0,
              costAud: 0,
              orders: 0,
              rating: 0,
              image: '',
              url: result.url || '',
              supplier: { name: 'Unknown', platform: 'unknown', id: '' },
            });
          }
        });

        await this.sleep(1500);
      } catch (err) {
        logger.warn(`TrendScout: Brave Search failed for "${query}" — ${err.message}`);
      }
    }

    return products;
  }

  inferCategory(name, description) {
    const text = (name + ' ' + description).toLowerCase();
    const categories = {
      'electronics': ['phone', 'charger', 'cable', 'bluetooth', 'wireless', 'speaker', 'headphone', 'earbuds', 'tech', 'led', 'usb'],
      'home': ['home', 'kitchen', 'organizer', 'storage', 'lamp', 'pillow', 'blanket', 'decor'],
      'beauty': ['beauty', 'skincare', 'makeup', 'hair', 'brush', 'serum', 'cream'],
      'fashion': ['fashion', 'watch', 'jewelry', 'bag', 'wallet', 'sunglasses', 'ring', 'necklace'],
      'fitness': ['fitness', 'yoga', 'gym', 'exercise', 'resistance', 'workout', 'sports'],
      'pet': ['pet', 'dog', 'cat', 'collar', 'leash'],
    };

    for (const [cat, keywords] of Object.entries(categories)) {
      if (keywords.some(k => text.includes(k))) return cat;
    }
    return 'general';
  }

  // ============================================
  // SCORING ENGINE
  // ============================================

  scoreProduct(product) {
        let score = 0;

      // Base score for CJ products (reliable API data)
      score += 15;

      // Sales velocity (listedNum = number of times listed/sold)
      if (product.orders > 10000) score += 25;
        else if (product.orders > 5000) score += 20;
        else if (product.orders > 1000) score += 15;
        else if (product.orders > 500) score += 10;
        else if (product.orders > 100) score += 5;

      // Price range scoring (good margin potential)
      const cost = product.costAud || product.costUsd || 0;
        if (cost >= 5 && cost <= 50) score += 20;
        else if (cost > 50 && cost <= 100) score += 15;
        else if (cost > 100 && cost <= 200) score += 10;
        else if (cost > 0 && cost < 5) score += 5;

      // Category bonus
      const highDemandCategories = ['electronics', 'home', 'beauty', 'fashion', 'sports', 'toys', 'kitchen', 'garden', 'pet'];
        const catLower = (product.category || '').toLowerCase();
        if (highDemandCategories.some(c => catLower.includes(c))) {
                score += 10;
        }

      // Has image bonus
      if (product.image) score += 5;

      // Has good name (not too short)
      if (product.name && product.name.length > 10) score += 5;

      product.trendScore = Math.min(score, 100);
        return product;
  }

  // ============================================
  // DUPLICATE CHECK
  // ============================================

  async isDuplicate(product) {
        try {
                const existing = await Product.findOne({
                          $or: [
                            { 'supplier.id': product.externalId },
                            { name: { $regex: new RegExp(product.name.substring(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }
                                    ]
                });
                return !!existing;
        } catch (err) {
                return false;
        }
  }

  // ============================================
  // MAIN SCAN METHOD
  // ============================================

  async scan() {
        if (!this.enabled) {
                logger.warn('TrendScout is disabled');
                return [];
        }

      logger.info('TrendScout scan starting (CJ Dropshipping API)...');
        let allProducts = [];

      try {
              // Fetch trending products (productFlag=0)
          const trending = await this.fetchCJProducts({
                    productFlag: 0,
                    size: 20,
                    page: 1
          });
              allProducts = allProducts.concat(trending);
              logger.info(`Found ${trending.length} trending CJ products`);

          // Rate limit: 1 req/sec on free tier
          await this.sleep(1100);

          // Fetch new products (productFlag=1)
          const newProducts = await this.fetchCJProducts({
                    productFlag: 1,
                    size: 20,
                    page: 1
          });
              allProducts = allProducts.concat(newProducts);
              logger.info(`Found ${newProducts.length} new CJ products`);

          // Fetch category-specific products for configured categories
          for (const category of this.categories.slice(0, 3)) {
                    await this.sleep(1100);
                    const catProducts = await this.fetchCJProducts({
                                keyword: category,
                                size: 10,
                                page: 1
                    });
                    allProducts = allProducts.concat(catProducts);
                    logger.info(`Found ${catProducts.length} CJ products for category: ${category}`);
          }
      } catch (err) {
              logger.error('TrendScout CJ scan error', { error: err.message });
      }

      // Brave Search trends (AliDrop)
      try {
              const braveTrends = await this.scrapeAliDropTrends();
              allProducts = allProducts.concat(braveTrends);
              logger.info(`Found ${braveTrends.length} products from Brave Search trends`);
      } catch (err) {
              logger.error('TrendScout Brave Search scan error', { error: err.message });
      }

      // Deduplicate by externalId
      const seen = new Set();
        allProducts = allProducts.filter(p => {
                if (seen.has(p.externalId)) return false;
                seen.add(p.externalId);
                return true;
        });

      // Score all products
      allProducts = allProducts.map(p => this.scoreProduct(p));

      // Filter by minimum score
      const qualified = allProducts.filter(p => p.trendScore >= this.minScore);

      // Sort by score descending
      qualified.sort((a, b) => b.trendScore - a.trendScore);

      // Limit to max products
      const limited = qualified.slice(0, this.maxProducts);

      // Remove duplicates already in database
      const fresh = [];
        for (const product of limited) {
                const isDup = await this.isDuplicate(product);
                if (!isDup) {
                          fresh.push(product);
                } else {
                          logger.info(`Skipping duplicate: ${product.name}`);
                }
        }

      logger.info(`TrendScout scan complete: ${allProducts.length} found, ${qualified.length} qualified, ${fresh.length} new products`);
        return fresh;
  }
}

module.exports = new TrendScout();
