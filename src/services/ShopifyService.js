// Stub ShopifyService - Shopify integration removed, replaced by WooCommerce
// This stub prevents import errors from files that still reference ShopifyService

const logger = require('../utils/logger');

class ShopifyService {
    async testConnection() {
          return { connected: false, reason: 'Shopify integration removed' };
    }

  async createProduct(product) {
        logger.warn('ShopifyService.createProduct called but Shopify is disabled');
        return { id: null, status: 'disabled' };
  }

  async updateProduct(productId, data) {
        logger.warn('ShopifyService.updateProduct called but Shopify is disabled');
        return { id: null, status: 'disabled' };
  }

  async deleteProduct(productId) {
        logger.warn('ShopifyService.deleteProduct called but Shopify is disabled');
        return { status: 'disabled' };
  }

  async getProduct(productId) {
        return null;
  }

  async getProducts() {
        return [];
  }

  async syncProduct(product) {
        logger.warn('ShopifyService.syncProduct called but Shopify is disabled');
        return { synced: false, reason: 'disabled' };
  }
}

module.exports = new ShopifyService();
