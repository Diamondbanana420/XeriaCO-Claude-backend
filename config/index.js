require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT) || 3001,
    env: process.env.NODE_ENV || 'production',
    apiPrefix: process.env.API_PREFIX || '/api',

    // Railway injects MONGODB_URL for its provisioned MongoDB
    // Falls back to MONGODB_URI for manual config
    mongo: {
          uri: process.env.MONGO_URL || process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017/xeriaco',    options: {
                  maxPoolSize: 10,
                  serverSelectionTimeoutMS: 10000,
                  socketTimeoutMS: 45000,
          }
    },

    woocommerce: {
          url: process.env.WOOCOMMERCE_URL || '',
          consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY || '',
          consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET || '',
          version: 'wc/v3',
    },

    cjDropshipping: {
          accessToken: process.env.CJ_ACCESS_TOKEN || '',
          email: process.env.CJ_EMAIL || '',
          password: process.env.CJ_PASSWORD || '',
          apiUrl: 'https://developers.cjdropshipping.com/api2.0/v1',
    },

    pricing: {
          defaultMarkup: parseFloat(process.env.DEFAULT_MARKUP_PERCENT) || 45,
          minProfitAud: parseFloat(process.env.MIN_PROFIT_MARGIN_AUD) || 8.0,
          exchangeRate: parseFloat(process.env.USD_TO_AUD_RATE) || 1.55,
          tiers: [
            { maxCostUsd: 10, markupPercent: 65 },
            { maxCostUsd: 30, markupPercent: 55 },
            { maxCostUsd: 60, markupPercent: 45 },
            { maxCostUsd: Infinity, markupPercent: 35 },
                ],
          // Psychological pricing: round to .95 or .99
          psychologicalEndings: [0.95, 0.99],
    },

    clawdbot: {
          webhookUrl: process.env.CLAWDBOT_WEBHOOK_URL || '',
          apiKey: process.env.CLAWDBOT_API_KEY || '',
          discordChannelId: process.env.DISCORD_ALERT_CHANNEL_ID || '1467990957629640850',
    },

    // Auto-detect Railway public domain for callbacks
    backendUrl: process.env.BACKEND_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),

    pipeline: {
          maxProductsPerRun: parseInt(process.env.MAX_PRODUCTS_PER_RUN) || 50,
          scrapeDelayMs: parseInt(process.env.SCRAPE_DELAY_MS) || 2500,
          defaultProductStatus: process.env.PRODUCT_DEFAULT_STATUS || 'draft',
          userAgents: [
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/17.2',
                ],
    },

    admin: {
          password: process.env.ADMIN_PASSWORD || 'xeriaco2026',
    },

    airtable: {
          apiKey: process.env.AIRTABLE_API_KEY || '',
          baseId: process.env.AIRTABLE_BASE_ID || '',
          tables: {
                  products: process.env.AIRTABLE_PRODUCTS_TABLE || 'Products',
                  orders: process.env.AIRTABLE_ORDERS_TABLE || 'Orders',
          },
    },

    anthropic: {
          apiKey: process.env.ANTHROPIC_API_KEY || '',
          model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
          maxTokens: parseInt(process.env.AI_MAX_TOKENS) || 1024,
    },

        emergent: {
                    apiKey: process.env.EMERGENT_API_KEY || '',
                    baseUrl: process.env.EMERGENT_BASE_URL || 'https://api.emergent.sh/v1',
                    model: process.env.EMERGENT_MODEL || 'claude-sonnet-4-20250514',
        },

    n8n: {
          webhookBaseUrl: process.env.N8N_WEBHOOK_BASE_URL || '',
          apiKey: process.env.N8N_API_KEY || '',
          workflows: {
                  newOrder: process.env.N8N_WORKFLOW_NEW_ORDER || '',
                  pipelineComplete: process.env.N8N_WORKFLOW_PIPELINE_COMPLETE || '',
                  lowStock: process.env.N8N_WORKFLOW_LOW_STOCK || '',
                  supplierOrder: process.env.N8N_WORKFLOW_SUPPLIER_ORDER || '',
          },
    },

    competitors: {
          scrapeEnabled: process.env.COMPETITOR_SCRAPE_ENABLED === 'true',
          scrapeIntervalHours: parseInt(process.env.COMPETITOR_SCRAPE_INTERVAL_HOURS) || 12,
          maxCompetitorsPerProduct: parseInt(process.env.MAX_COMPETITORS_PER_PRODUCT) || 5,
          autoPriceAdjust: process.env.COMPETITOR_AUTO_PRICE_ADJUST === 'true',
    },

    trendScout: {
          enabled: process.env.TRENDSCOUT_ENABLED === 'true',
          maxProductsPerScan: parseInt(process.env.TRENDSCOUT_MAX_PRODUCTS) || 20,
          minTrendScore: parseInt(process.env.TRENDSCOUT_MIN_SCORE) || 20,
          categories: (process.env.TRENDSCOUT_CATEGORIES || 'tech,home,lifestyle,fashion,fitness').split(','),
    },

    gemini: {
          apiKey: process.env.GEMINI_API_KEY || '',
          model: 'gemini-2.0-flash',
    },

    deepseek: {
          apiKey: process.env.DEEPSEEK_API_KEY || '',
          model: 'deepseek-chat',
          baseUrl: 'https://api.deepseek.com/v1',
    },

    braveSearch: {
          apiKey: process.env.BRAVE_SEARCH_API_KEY || '',
    },

    stripe: {
          secretKey: process.env.STRIPE_SECRET_KEY || '',
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    },

    logging: {
          level: process.env.LOG_LEVEL || 'info',
    },
};

module.exports = config;
