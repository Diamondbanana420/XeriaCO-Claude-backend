const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

class ImageSourcer {
  constructor() {
    this.enabled = !!config.braveSearch?.apiKey;
  }

  async findImages(product) {
    if (!this.enabled) {
      logger.warn('ImageSourcer: Brave Search API key not configured');
      return product;
    }

    try {
      const query = encodeURIComponent(`${product.title} product photo`);
      const response = await axios.get(
        `https://api.search.brave.com/res/v1/images/search?q=${query}&count=5`,
        { headers: { 'X-Subscription-Token': config.braveSearch.apiKey } }
      );

      const results = response.data.results || [];

      if (results.length > 0) {
        product.featuredImage = results[0].properties?.url || results[0].thumbnail?.src || '';
        product.images = results.slice(0, 3).map(r => r.properties?.url || r.thumbnail?.src || '').filter(Boolean);
        logger.info(`ImageSourcer: Found ${product.images.length} images for "${product.title}"`);
      } else {
        logger.warn(`ImageSourcer: No images found for "${product.title}"`);
      }
    } catch (err) {
      logger.warn(`ImageSourcer: Failed for "${product.title}" — ${err.message}`);
    }

    return product;
  }

  async enrichAll() {
    const { Product } = require('../models');
    const products = await Product.find({
      isActive: true,
      $or: [
        { featuredImage: { $in: [null, ''] } },
        { featuredImage: { $exists: false } },
      ],
    });

    logger.info(`ImageSourcer: Enriching ${products.length} products without images`);
    let enriched = 0;

    for (const product of products) {
      try {
        await this.findImages(product);
        await product.save();
        enriched++;
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        logger.warn(`ImageSourcer: Failed to save images for "${product.title}" — ${err.message}`);
      }
    }

    logger.info(`ImageSourcer: Enriched ${enriched}/${products.length} products`);
    return { total: products.length, enriched };
  }
}

module.exports = new ImageSourcer();
