/**
 * KlaviyoService — Automated email/SMS marketing via Klaviyo API
 * Connected to OpenClaw bot for Discord alerts on marketing events
 * 
 * Free tier: 250 contacts, 500 emails/month
 */

const axios = require('axios');

class KlaviyoService {
  constructor() {
    this.apiKey = process.env.KLAVIYO_PRIVATE_API_KEY || '';
    this.publicKey = process.env.KLAVIYO_PUBLIC_API_KEY || '';
    this.enabled = !!this.apiKey;
    this.baseURL = 'https://a.klaviyo.com/api';
    this.revision = '2024-10-15';
    this.logger = null;
    this.clawdbotBridge = null;
  }

  init(logger, clawdbotBridge) {
    this.logger = logger || console;
    this.clawdbotBridge = clawdbotBridge;
  }

  getHeaders() {
    return {
      'Authorization': `Klaviyo-API-Key ${this.apiKey}`,
      'Content-Type': 'application/json',
      'revision': this.revision,
    };
  }

  async request(method, endpoint, data = null) {
    if (!this.enabled) return null;
    try {
      const config = {
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: this.getHeaders(),
        timeout: 15000,
      };
      if (data) config.data = data;
      const res = await axios(config);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.errors?.[0]?.detail || err.message;
      this.logger.error(`Klaviyo API error: ${method} ${endpoint} → ${status}: ${detail}`);
      return null;
    }
  }

  // ═══════════════════════════════════════
  // PROFILES
  // ═══════════════════════════════════════
  async upsertProfile({ email, firstName, lastName, phone, properties = {} }) {
    return this.request('POST', '/profiles/', {
      data: {
        type: 'profile',
        attributes: {
          email,
          first_name: firstName,
          last_name: lastName,
          phone_number: phone,
          properties: { source: 'xeriaco', ...properties },
        },
      },
    });
  }

  // ═══════════════════════════════════════
  // LISTS
  // ═══════════════════════════════════════
  async getLists() {
    return this.request('GET', '/lists/');
  }

  async addToList(listId, emails) {
    const profiles = emails.map(email => ({
      type: 'profile',
      attributes: { email },
    }));
    return this.request('POST', `/lists/${listId}/relationships/profiles/`, {
      data: profiles,
    });
  }

  // ═══════════════════════════════════════
  // EVENTS — Triggers Klaviyo flows
  // ═══════════════════════════════════════
  async trackEvent(email, eventName, properties = {}) {
    return this.request('POST', '/events/', {
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: eventName } } },
          profile: { data: { type: 'profile', attributes: { email } } },
          properties,
          time: new Date().toISOString(),
        },
      },
    });
  }

  async trackPlacedOrder(order) {
    const email = order.email || order.customer?.email;
    if (!email) return null;
    return this.trackEvent(email, 'Placed Order', {
      OrderId: order.id || order.order_number,
      ItemNames: (order.line_items || []).map(i => i.title),
      Items: (order.line_items || []).map(i => ({
        ProductID: i.product_id,
        SKU: i.sku,
        ProductName: i.title,
        Quantity: i.quantity,
        ItemPrice: parseFloat(i.price),
        ImageURL: i.image?.src || '',
      })),
      '$value': parseFloat(order.total_price || 0),
      Currency: order.currency || 'AUD',
    });
  }

  async trackStartedCheckout(email, cart) {
    return this.trackEvent(email, 'Started Checkout', {
      '$value': cart.totalPrice || 0,
      ItemNames: (cart.items || []).map(i => i.title),
      Items: (cart.items || []).map(i => ({
        ProductID: i.productId,
        ProductName: i.title,
        Quantity: i.quantity,
        ItemPrice: i.price,
      })),
    });
  }

  async trackViewedProduct(email, product) {
    return this.trackEvent(email, 'Viewed Product', {
      ProductName: product.title,
      ProductID: product._id || product.shopifyProductId,
      Categories: [product.category || 'General'],
      ImageURL: product.featuredImage || '',
      Brand: 'XeriaCO',
      Price: product.sellingPriceAud || product.price || 0,
    });
  }

  async trackNewProductAvailable(product) {
    return this.trackEvent('system@xeriaco.com.au', 'New Product Available', {
      ProductName: product.title,
      ProductID: product._id || product.shopifyProductId,
      Category: product.category || 'General',
      Price: product.sellingPriceAud || 0,
      ImageURL: product.featuredImage || '',
    });
  }

  // ═══════════════════════════════════════
  // CAMPAIGNS
  // ═══════════════════════════════════════
  async createCampaign({ name, listId, subject, previewText }) {
    return this.request('POST', '/campaigns/', {
      data: {
        type: 'campaign',
        attributes: {
          name,
          audiences: { included: [{ type: 'list', id: listId }] },
          campaign_messages: {
            data: [{
              type: 'campaign-message',
              attributes: {
                channel: 'email',
                label: name,
                content: { subject, preview_text: previewText || '' },
              },
            }],
          },
          send_strategy: { method: 'immediate' },
        },
      },
    });
  }

  // ═══════════════════════════════════════
  // CATALOG SYNC
  // ═══════════════════════════════════════
  async syncProductToCatalog(product) {
    const externalId = product._id?.toString() || product.shopifyProductId;
    return this.request('POST', '/catalog-items/', {
      data: {
        type: 'catalog-item',
        attributes: {
          external_id: externalId,
          title: product.title,
          description: (product.description || '').substring(0, 5000),
          url: product.shopifyUrl || `https://xeria-378.myshopify.com/products/${product.handle || ''}`,
          image_full_url: product.featuredImage || '',
          price: product.sellingPriceAud || 0,
          custom_metadata: {
            category: product.category || 'General',
            compare_price: product.comparePriceAud || null,
            trend_score: product.trendScore || 0,
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════
  // HEALTH
  // ═══════════════════════════════════════
  async healthCheck() {
    if (!this.enabled) return { status: 'disabled', reason: 'No API key' };
    const lists = await this.getLists();
    if (lists) return { status: 'connected', listCount: lists.data?.length || 0 };
    return { status: 'error', reason: 'Connection failed' };
  }
}

module.exports = new KlaviyoService();
