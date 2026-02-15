/**
 * SocialPoster — Auto-posts products to Instagram, Facebook, Pinterest
 * Reports all results to OpenClaw bot via ClawdbotBridge
 */

const axios = require('axios');

class SocialPoster {
  constructor() {
    this.metaToken = process.env.META_PAGE_ACCESS_TOKEN || '';
    this.metaPageId = process.env.META_PAGE_ID || '';
    this.igUserId = process.env.META_IG_USER_ID || '';
    this.metaEnabled = !!(this.metaToken && this.metaPageId);
    this.igEnabled = !!(this.metaToken && this.igUserId);

    this.pinterestToken = process.env.PINTEREST_ACCESS_TOKEN || '';
    this.pinterestBoardId = process.env.PINTEREST_BOARD_ID || '';
    this.pinterestEnabled = !!(this.pinterestToken && this.pinterestBoardId);

    this.storeDomain = process.env.STORE_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'xeria-378.myshopify.com';

    this.aiGenerator = null;
    this.logger = null;
    this.clawdbotBridge = null;

    this.lastPostTime = {};
    this.minPostIntervalMs = 2 * 60 * 60 * 1000; // 2 hours
  }

  init(logger, clawdbotBridge, aiGenerator) {
    this.logger = logger || console;
    this.clawdbotBridge = clawdbotBridge;
    this.aiGenerator = aiGenerator || null;
  }

  // ═══════════════════════════════════════
  // AI COPY GENERATION
  // ═══════════════════════════════════════
  async generateSocialCopy(product, platform) {
    if (!this.aiGenerator) return this._fallbackCopy(product, platform);

    const systemPrompt = `You are a social media copywriter for XeriaCO, a premium Australian online store.
Write compelling ${platform} posts that drive clicks. Brand voice: modern, confident, slightly playful.
Always include a CTA. Max 3 emojis. Australian English.`;

    const limits = { instagram: 2200, facebook: 500, pinterest: 500 };

    const userPrompt = `Write a ${platform} post for:
Title: ${product.title}
Price: $${product.sellingPriceAud || product.price || '??'} AUD
${product.comparePriceAud ? `Was: $${product.comparePriceAud} AUD` : ''}
Category: ${product.category || 'lifestyle'}
Description: ${(product.description || '').substring(0, 300)}

Max ${limits[platform] || 500} chars. Include 3-5 hashtags. Include CTA.
Return ONLY the post text.`;

    try {
      const copy = await this.aiGenerator.generate(systemPrompt, userPrompt, 300);
      return copy || this._fallbackCopy(product, platform);
    } catch (err) {
      this.logger.warn(`SocialPoster: AI copy failed: ${err.message}`);
      return this._fallbackCopy(product, platform);
    }
  }

  _fallbackCopy(product, platform) {
    const price = product.sellingPriceAud || product.price || '??';
    const title = product.title || 'New Arrival';
    const save = product.comparePriceAud ? `\nWas $${product.comparePriceAud} — now $${price} AUD!` : '';
    return `✨ New Drop: ${title}${save}\n$${price} AUD — Shop now at XeriaCO\n\n#XeriaCO #${product.category || 'lifestyle'} #shopnow #trending`;
  }

  canPost(platform) {
    const last = this.lastPostTime[platform] || 0;
    return Date.now() - last >= this.minPostIntervalMs;
  }

  markPosted(platform) {
    this.lastPostTime[platform] = Date.now();
  }

  // ═══════════════════════════════════════
  // INSTAGRAM
  // ═══════════════════════════════════════
  async postToInstagram(product) {
    if (!this.igEnabled) return { success: false, reason: 'not_configured' };
    if (!this.canPost('instagram')) return { success: false, reason: 'rate_limited' };

    try {
      const caption = await this.generateSocialCopy(product, 'instagram');
      const imageUrl = product.featuredImage || product.images?.[0];
      if (!imageUrl) return { success: false, reason: 'no_image' };

      // Create media container
      const containerRes = await axios.post(
        `https://graph.facebook.com/v22.0/${this.igUserId}/media`,
        { image_url: imageUrl, caption, access_token: this.metaToken }
      );
      const containerId = containerRes.data?.id;
      if (!containerId) throw new Error('No container ID');

      await new Promise(r => setTimeout(r, 5000));

      // Publish
      const publishRes = await axios.post(
        `https://graph.facebook.com/v22.0/${this.igUserId}/media_publish`,
        { creation_id: containerId, access_token: this.metaToken }
      );

      this.markPosted('instagram');
      this.logger.info(`SocialPoster: IG posted — ${product.title}`);
      return { success: true, platform: 'instagram', postId: publishRes.data?.id };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      this.logger.error(`SocialPoster: IG failed: ${msg}`);
      return { success: false, reason: msg };
    }
  }

  // ═══════════════════════════════════════
  // FACEBOOK
  // ═══════════════════════════════════════
  async postToFacebook(product) {
    if (!this.metaEnabled) return { success: false, reason: 'not_configured' };
    if (!this.canPost('facebook')) return { success: false, reason: 'rate_limited' };

    try {
      const message = await this.generateSocialCopy(product, 'facebook');
      const imageUrl = product.featuredImage || product.images?.[0];

      const postData = {
        message,
        link: `https://${this.storeDomain}`,
        access_token: this.metaToken,
      };

      let res;
      if (imageUrl) {
        res = await axios.post(
          `https://graph.facebook.com/v22.0/${this.metaPageId}/photos`,
          { ...postData, url: imageUrl }
        );
      } else {
        res = await axios.post(
          `https://graph.facebook.com/v22.0/${this.metaPageId}/feed`,
          postData
        );
      }

      this.markPosted('facebook');
      this.logger.info(`SocialPoster: FB posted — ${product.title}`);
      return { success: true, platform: 'facebook', postId: res.data?.id };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      this.logger.error(`SocialPoster: FB failed: ${msg}`);
      return { success: false, reason: msg };
    }
  }

  // ═══════════════════════════════════════
  // PINTEREST
  // ═══════════════════════════════════════
  async postToPinterest(product) {
    if (!this.pinterestEnabled) return { success: false, reason: 'not_configured' };
    if (!this.canPost('pinterest')) return { success: false, reason: 'rate_limited' };

    try {
      const description = await this.generateSocialCopy(product, 'pinterest');
      const imageUrl = product.featuredImage || product.images?.[0];
      if (!imageUrl) return { success: false, reason: 'no_image' };

      const res = await axios.post(
        'https://api.pinterest.com/v5/pins',
        {
          board_id: this.pinterestBoardId,
          title: product.title,
          description,
          link: `https://${this.storeDomain}`,
          media_source: { source_type: 'image_url', url: imageUrl },
        },
        { headers: { 'Authorization': `Bearer ${this.pinterestToken}`, 'Content-Type': 'application/json' } }
      );

      this.markPosted('pinterest');
      this.logger.info(`SocialPoster: Pinterest pinned — ${product.title}`);
      return { success: true, platform: 'pinterest', pinId: res.data?.id };
    } catch (err) {
      this.logger.error(`SocialPoster: Pinterest failed: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }

  // ═══════════════════════════════════════
  // POST TO ALL + OPENCLAW REPORT
  // ═══════════════════════════════════════
  async postProductToAll(product) {
    this.logger.info(`SocialPoster: Broadcasting "${product.title}"...`);

    const results = await Promise.allSettled([
      this.postToInstagram(product),
      this.postToFacebook(product),
      this.postToPinterest(product),
    ]);

    const summary = {
      instagram: results[0]?.value || { success: false },
      facebook: results[1]?.value || { success: false },
      pinterest: results[2]?.value || { success: false },
    };

    const successCount = Object.values(summary).filter(r => r.success).length;
    const totalChannels = Object.keys(summary).length;

    if (this.clawdbotBridge) {
      try {
        await this.clawdbotBridge.sendCommand('marketing_social_report', {
          product: product.title,
          image: product.featuredImage || '',
          results: summary,
          successCount,
          totalChannels,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.warn(`SocialPoster: OpenClaw report failed: ${err.message}`);
      }
    }

    return summary;
  }

  /**
   * Post pre-generated content (from approval queue) to all channels.
   * Uses the AI-generated image and captions instead of generating new ones.
   */
  async postContentToAll(content) {
    this.logger.info(`SocialPoster: Posting approved content for "${content.title}"...`);
    const imageUrl = content.image;
    const results = {};

    // Instagram — use pre-generated caption
    if (this.igEnabled) {
      try {
        const caption = (content.caption?.instagram || content.title) +
          '\n\n' + (content.caption?.hashtags || []).map(h => `#${h}`).join(' ');
        const containerRes = await axios.post(
          `https://graph.facebook.com/v22.0/${this.igUserId}/media`,
          { image_url: imageUrl, caption, access_token: this.metaToken }
        );
        const containerId = containerRes.data?.id;
        if (containerId) {
          await new Promise(r => setTimeout(r, 5000));
          const publishRes = await axios.post(
            `https://graph.facebook.com/v22.0/${this.igUserId}/media_publish`,
            { creation_id: containerId, access_token: this.metaToken }
          );
          results.instagram = { success: true, postId: publishRes.data?.id };
          this.markPosted('instagram');
        } else {
          results.instagram = { success: false, reason: 'No container ID' };
        }
      } catch (err) {
        results.instagram = { success: false, reason: err.response?.data?.error?.message || err.message };
      }
    } else {
      results.instagram = { success: false, reason: 'not_configured' };
    }

    // Facebook — use pre-generated caption
    if (this.metaEnabled) {
      try {
        const message = content.caption?.facebook || content.title;
        const postData = { message, access_token: this.metaToken, link: `https://${this.storeDomain}` };
        const res = imageUrl
          ? await axios.post(`https://graph.facebook.com/v22.0/${this.metaPageId}/photos`, { ...postData, url: imageUrl })
          : await axios.post(`https://graph.facebook.com/v22.0/${this.metaPageId}/feed`, postData);
        results.facebook = { success: true, postId: res.data?.id };
        this.markPosted('facebook');
      } catch (err) {
        results.facebook = { success: false, reason: err.response?.data?.error?.message || err.message };
      }
    } else {
      results.facebook = { success: false, reason: 'not_configured' };
    }

    // Pinterest — use pre-generated caption
    if (this.pinterestEnabled) {
      try {
        if (!imageUrl) throw new Error('No image');
        const res = await axios.post('https://api.pinterest.com/v5/pins', {
          board_id: this.pinterestBoardId,
          title: content.title,
          description: content.caption?.pinterest || content.title,
          link: `https://${this.storeDomain}`,
          media_source: { source_type: 'image_url', url: imageUrl },
        }, { headers: { 'Authorization': `Bearer ${this.pinterestToken}`, 'Content-Type': 'application/json' } });
        results.pinterest = { success: true, pinId: res.data?.id };
        this.markPosted('pinterest');
      } catch (err) {
        results.pinterest = { success: false, reason: err.message };
      }
    } else {
      results.pinterest = { success: false, reason: 'not_configured' };
    }

    const successCount = Object.values(results).filter(r => r.success).length;
    if (this.clawdbotBridge) {
      try {
        await this.clawdbotBridge.sendCommand('marketing_content_posted', {
          product: content.title, image: imageUrl, results, successCount,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {}
    }

    return results;
  }

  getStatus() {
    return {
      instagram: this.igEnabled ? 'configured' : 'disabled',
      facebook: this.metaEnabled ? 'configured' : 'disabled',
      pinterest: this.pinterestEnabled ? 'configured' : 'disabled',
    };
  }
}

module.exports = new SocialPoster();
