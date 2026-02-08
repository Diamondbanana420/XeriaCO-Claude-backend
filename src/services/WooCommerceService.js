const axios = require('axios');

/**
 * WooCommerceService - Direct WooCommerce REST API Integration
 */
class WooCommerceService {
    constructor() {
          this.baseUrl = process.env.WOOCOMMERCE_URL;
          this.consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
          this.consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;
          this.version = 'wc/v3';
    }

  getAuthParams() {
        return {
                consumer_key: this.consumerKey,
                consumer_secret: this.consumerSecret
        };
  }

  async request(endpoint, method = 'GET', data = null) {
        const url = `${this.baseUrl}/wp-json/${this.version}/${endpoint}`;
        try {
                const response = await axios({
                          method,
                          url,
                          params: method === 'GET' ? { ...this.getAuthParams(), ...data } : this.getAuthParams(),
                          data: method !== 'GET' ? data : undefined,
                          headers: { 'Content-Type': 'application/json' }
                });
                return response.data;
        } catch (error) {
                console.error(`WooCommerce API Error: ${error.message}`);
                throw error;
        }
  }

  async testConnection() {
        try {
                const result = await this.request('system_status');
                return { connected: true, store: result.environment?.site_url };
        } catch (error) {
                return { connected: false, error: error.message };
        }
  }

  async listProducts(params = {}) {
        return this.request('products', 'GET', { per_page: params.limit || 100, page: params.page || 1, ...params });
  }

  async getProduct(productId) {
        return this.request(`products/${productId}`);
  }

  async createProduct(productData) {
        return this.request('products', 'POST', productData);
  }

  async updateProduct(productId, productData) {
        return this.request(`products/${productId}`, 'PUT', productData);
  }

  async deleteProduct(productId) {
        return this.request(`products/${productId}`, 'DELETE', { force: true });
  }

  async listOrders(params = {}) {
        return this.request('orders', 'GET', { per_page: params.limit || 100, page: params.page || 1, ...params });
  }

  async getOrder(orderId) {
        return this.request(`orders/${orderId}`);
  }

  async createOrder(orderData) {
        return this.request('orders', 'POST', orderData);
  }

  async listCustomers(params = {}) {
        return this.request('customers', 'GET', { per_page: params.limit || 100, ...params });
  }

  async listCategories(params = {}) {
        return this.request('products/categories', 'GET', params);
  }

  async syncProduct(product) {
        const images = [];
        if (product.featuredImage) {
                images.push({ src: product.featuredImage, alt: product.title });
        }
        if (Array.isArray(product.images)) {
                for (const img of product.images) {
                        const src = typeof img === 'string' ? img : img.url;
                        if (src && src !== product.featuredImage) {
                                images.push({ src, alt: product.title });
                        }
                }
        }

        const wooData = {
                name: product.title,
                description: product.aiContent?.description || product.description || '',
                short_description: product.aiContent?.shortDescription || product.title,
                regular_price: String(product.comparePriceAud || product.sellingPriceAud || '0'),
                sale_price: String(product.sellingPriceAud || '0'),
                images: images.slice(0, 5),
                categories: product.category ? [{ name: product.category }] : [],
                status: 'publish',
        };

        let result;
        if (product.woocommerceProductId) {
                result = await this.updateProduct(product.woocommerceProductId, wooData);
        } else {
                result = await this.createProduct(wooData);
        }

        const { Product } = require('../models');
        await Product.findByIdAndUpdate(product._id, {
                woocommerceProductId: String(result.id),
                woocommerceSlug: result.slug || '',
                woocommerceStatus: 'published',
                lastSyncedToWooCommerce: new Date(),
        });

        return result;
  }

  async syncAll() {
        const { Product } = require('../models');
        const products = await Product.find({
                isActive: true,
                'pipeline.approved': true,
                $or: [
                        { woocommerceStatus: { $in: ['draft', '', null] } },
                        { woocommerceStatus: { $exists: false } },
                ],
        });

        let synced = 0;
        for (const product of products) {
                try {
                        await this.syncProduct(product);
                        synced++;
                } catch (err) {
                        console.error(`WooCommerce sync failed for ${product.title}: ${err.message}`);
                }
        }

        return { synced, total: products.length };
  }
}

module.exports = new WooCommerceService();
