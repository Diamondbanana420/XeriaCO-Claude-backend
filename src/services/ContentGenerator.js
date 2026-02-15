/**
 * ContentGenerator — AI marketing content creation
 * 
 * Uses:
 * - fal.ai Flux 1.1 Pro for marketing images (~$0.04/image)
 * - Claude (existing Anthropic key) for captions + image prompts
 * 
 * Flow:
 * 1. Claude generates image prompt + social captions
 * 2. fal.ai generates 1 marketing image
 * 3. Everything saved to MarketingContent model for approval
 * 
 * Cost per product: ~$0.05 (image + caption)
 */

const axios = require('axios');
const logger = require('../utils/logger');

class ContentGenerator {
  constructor() {
    this.falApiKey = null;
    this.anthropicClient = null;
    this.anthropicModel = null;
    this.isEnabled = false;
    this.stats = { imagesGenerated: 0, captionsGenerated: 0, totalCost: 0 };
  }

  init(aiContentGenerator) {
    this.falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY || '';
    this.anthropicClient = aiContentGenerator?.getAnthropicClient?.();
    this.anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
    this.isEnabled = !!(this.falApiKey && this.anthropicClient);

    if (!this.falApiKey) logger.warn('ContentGenerator: FAL_KEY not set — image generation disabled');
    if (!this.anthropicClient) logger.warn('ContentGenerator: Anthropic not available — caption generation disabled');
    if (this.isEnabled) logger.info('ContentGenerator: Ready (fal.ai + Claude)');
  }

  getStatus() {
    return {
      enabled: this.isEnabled,
      falConfigured: !!this.falApiKey,
      anthropicConfigured: !!this.anthropicClient,
      stats: this.stats,
    };
  }

  async generateCaptions(product) {
    if (!this.anthropicClient) throw new Error('Anthropic not configured');

    const prompt = `You are a premium e-commerce social media copywriter for XeriaCO, an Australian online store selling smart tech and lifestyle products.

Generate marketing captions for this product:
- Title: ${product.title}
- Price: $${product.sellingPriceAud || product.price || '?'} AUD
- Category: ${product.category || 'General'}
- Description: ${product.description || product.aiContent?.description || 'No description'}

Return ONLY valid JSON (no markdown, no backticks):
{
  "instagram": "Instagram caption (engaging, emoji-rich, 150-200 chars, include CTA)",
  "facebook": "Facebook post (slightly longer, 200-280 chars, conversational tone)",
  "pinterest": "Pinterest description (SEO-focused, 100-160 chars, keyword-rich)",
  "hashtags": ["relevant", "hashtags", "8to12", "nospaces"],
  "cta": "Shop now at XeriaCO — Free shipping over $75 AUD",
  "imagePrompt": "A detailed prompt for generating a premium product marketing photo. Describe a lifestyle scene with the product in use. Be specific about lighting, angle, background, mood. No text overlays. Photorealistic style. Square format 1024x1024."
}`;

    const response = await this.anthropicClient.messages.create({
      model: this.anthropicModel,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse caption JSON from Claude');
    
    const parsed = JSON.parse(jsonMatch[0]);
    this.stats.captionsGenerated++;
    this.stats.totalCost += 0.01;
    return parsed;
  }

  async generateImage(imagePrompt, productTitle) {
    if (!this.falApiKey) throw new Error('FAL_KEY not configured');

    logger.info(`ContentGenerator: Generating image for "${productTitle}"`);

    const submitRes = await axios.post(
      'https://queue.fal.run/fal-ai/flux-pro/v1.1',
      {
        prompt: imagePrompt,
        image_size: 'square_hd',
        num_images: 1,
        enable_safety_checker: true,
        output_format: 'jpeg',
      },
      {
        headers: {
          'Authorization': `Key ${this.falApiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const requestId = submitRes.data?.request_id;
    if (!requestId) {
      const imageUrl = submitRes.data?.images?.[0]?.url;
      if (!imageUrl) throw new Error('No image URL in fal.ai response');
      this.stats.imagesGenerated++;
      this.stats.totalCost += 0.04;
      return { url: imageUrl, cost: 0.04 };
    }

    const imageUrl = await this._pollFalResult('fal-ai/flux-pro/v1.1', requestId, 120);
    this.stats.imagesGenerated++;
    this.stats.totalCost += 0.04;
    return { url: imageUrl, cost: 0.04 };
  }

  async generateForProduct(product) {
    const result = {
      caption: null,
      image: { status: 'pending' },
      generationCost: 0,
    };

    // Step 1: Captions + image prompt from Claude
    let imagePrompt;
    try {
      const captions = await this.generateCaptions(product);
      result.caption = {
        instagram: captions.instagram,
        facebook: captions.facebook,
        pinterest: captions.pinterest,
        hashtags: captions.hashtags || [],
        cta: captions.cta || 'Shop now at XeriaCO',
      };
      imagePrompt = captions.imagePrompt;
      result.generationCost += 0.01;
    } catch (err) {
      logger.error(`ContentGenerator: Caption gen failed for "${product.title}": ${err.message}`);
      throw err;
    }

    // Step 2: Image from fal.ai
    try {
      const img = await this.generateImage(imagePrompt, product.title);
      result.image = {
        url: img.url,
        prompt: imagePrompt,
        model: 'flux-1.1-pro',
        status: 'ready',
        generatedAt: new Date(),
      };
      result.generationCost += img.cost;
    } catch (err) {
      logger.error(`ContentGenerator: Image gen failed for "${product.title}": ${err.message}`);
      result.image = { status: 'failed', error: err.message, prompt: imagePrompt, model: 'flux-1.1-pro' };
    }

    return result;
  }

  async _pollFalResult(model, requestId, maxWaitSec = 120) {
    const pollUrl = `https://queue.fal.run/${model}/requests/${requestId}/status`;
    const resultUrl = `https://queue.fal.run/${model}/requests/${requestId}`;
    const startTime = Date.now();

    while ((Date.now() - startTime) < maxWaitSec * 1000) {
      await new Promise(r => setTimeout(r, 3000));

      try {
        const statusRes = await axios.get(pollUrl, {
          headers: { 'Authorization': `Key ${this.falApiKey}` },
        });

        const status = statusRes.data?.status;
        if (status === 'COMPLETED') {
          const resultRes = await axios.get(resultUrl, {
            headers: { 'Authorization': `Key ${this.falApiKey}` },
          });
          const imageUrl = resultRes.data?.images?.[0]?.url;
          if (imageUrl) return imageUrl;
          throw new Error('Completed but no URL found in result');
        }

        if (status === 'FAILED') {
          throw new Error(`fal.ai generation failed: ${statusRes.data?.error || 'unknown'}`);
        }
      } catch (err) {
        if (err.response?.status === 404) continue;
        throw err;
      }
    }

    throw new Error(`fal.ai generation timed out after ${maxWaitSec}s`);
  }
}

module.exports = new ContentGenerator();
