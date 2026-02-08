const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

class AIContentGenerator {
  constructor() {
    this.anthropicEnabled = !!config.anthropic.apiKey;
    this.geminiEnabled = !!config.gemini?.apiKey;
    this.deepseekEnabled = !!config.deepseek?.apiKey;
    this.client = null;
  }

  getAnthropicClient() {
    if (!this.client && this.anthropicEnabled) {
      this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    }
    return this.client;
  }

  async generateWithAnthropic(prompt, maxTokens) {
    const client = this.getAnthropicClient();
    if (!client) throw new Error('Anthropic not configured');

    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: maxTokens || config.anthropic.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')
      .trim();
  }

  async generateWithGemini(prompt) {
    if (!config.gemini?.apiKey) throw new Error('Gemini not configured');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
    });

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  async generateWithDeepSeek(prompt) {
    if (!config.deepseek?.apiKey) throw new Error('DeepSeek not configured');

    const response = await axios.post(`${config.deepseek.baseUrl}/chat/completions`, {
      model: config.deepseek.model,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { Authorization: `Bearer ${config.deepseek.apiKey}` },
    });

    return response.data.choices?.[0]?.message?.content?.trim() || '';
  }

  async generate(prompt, maxTokens) {
    // Fallback chain: Anthropic → Gemini → DeepSeek
    const providers = [
      { name: 'Anthropic', fn: () => this.generateWithAnthropic(prompt, maxTokens), enabled: this.anthropicEnabled },
      { name: 'Gemini', fn: () => this.generateWithGemini(prompt), enabled: this.geminiEnabled },
      { name: 'DeepSeek', fn: () => this.generateWithDeepSeek(prompt), enabled: this.deepseekEnabled },
    ];

    for (const provider of providers) {
      if (!provider.enabled) continue;
      try {
        const result = await provider.fn();
        if (result) {
          logger.info(`AI Content: Generated via ${provider.name}`);
          return result;
        }
      } catch (err) {
        logger.warn(`AI Content: ${provider.name} failed — ${err.message}`);
      }
    }

    logger.warn('AI Content: All providers failed');
    return null;
  }

  // ═══════════════════════════════════════
  // Generate structured product content
  // ═══════════════════════════════════════
  async generateProductContent(product) {
    const prompt = `You are a premium ecommerce copywriter for XeriaCO, an Australian online store.

For the following product, generate a JSON object with these fields:
- "description": A compelling product description (150-250 words, premium tone, no cliches)
- "shortDescription": A 1-2 sentence summary
- "seoTitle": SEO meta title (max 60 chars, include product type and benefit)
- "seoDescription": SEO meta description (max 155 chars, for Australian buyers)
- "tags": Array of 5-10 relevant tags (category, use case, material, audience)

Product: ${product.title}
Category: ${product.category || 'general'}
Price: $${product.sellingPriceAud?.toFixed(2) || '0'} AUD
Existing tags: ${(product.tags || []).join(', ')}

Return ONLY raw JSON, no markdown fences or labels.`;

    const raw = await this.generate(prompt, 800);
    if (!raw) return null;

    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (err) {
      logger.warn('Failed to parse AI product content JSON', { raw: raw.substring(0, 200) });
      return null;
    }
  }

  // ═══════════════════════════════════════
  // Full product enrichment
  // ═══════════════════════════════════════
  async enrichProduct(product) {
    if (!this.anthropicEnabled && !this.geminiEnabled && !this.deepseekEnabled) {
      return { description: null, shortDescription: null, seoTitle: null, seoDescription: null, tags: null };
    }

    logger.info(`AI Content: Enriching "${product.title}"`);
    const content = await this.generateProductContent(product);

    if (!content) {
      return { description: null, shortDescription: null, seoTitle: null, seoDescription: null, tags: null };
    }

    logger.info(`AI Content: Enriched "${product.title}" — desc: ${!!content.description}, seo: ${!!content.seoTitle}, tags: ${content.tags?.length || 0}`);
    return {
      description: content.description || null,
      shortDescription: content.shortDescription || null,
      seoTitle: content.seoTitle || null,
      seoDescription: content.seoDescription || null,
      tags: content.tags || null,
    };
  }

  // ═══════════════════════════════════════
  // Bulk enrich unenriched products
  // ═══════════════════════════════════════
  async bulkEnrich(limit = 10) {
    const { Product } = require('../models');
    const products = await Product.find({
      isActive: true,
      $or: [
        { 'aiContent.description': { $in: [null, ''] } },
        { description: { $in: [null, ''] } },
      ],
    }).limit(limit);

    logger.info(`AI Content: Bulk enriching ${products.length} products`);
    let enriched = 0;

    for (const product of products) {
      try {
        const content = await this.enrichProduct(product);

        if (content.description) {
          product.aiContent = product.aiContent || {};
          product.aiContent.description = content.description;
          product.aiContent.shortDescription = content.shortDescription;
          product.aiContent.seoTitle = content.seoTitle;
          product.aiContent.seoDescription = content.seoDescription;
          if (!product.description) product.description = content.description;
        }
        if (content.tags && content.tags.length) {
          product.tags = [...new Set([...(product.tags || []), ...content.tags])];
        }

        await product.save();
        enriched++;

        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        logger.warn(`AI Content: Failed to enrich ${product.title}: ${err.message}`);
      }
    }

    return { total: products.length, enriched };
  }
}

module.exports = new AIContentGenerator();
