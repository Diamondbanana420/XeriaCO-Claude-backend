const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');
const { Product, RecommendationSession } = require('../models');

const router = express.Router();

// ═══════════════════════════════════════
// SYSTEM PROMPT — Product Recommendation Focus
// ═══════════════════════════════════════
const RECOMMENDATION_PROMPT = `You are XERI, the AI product recommendation engine for XeriaCO.

Your ONLY job: Given a customer's preferences (budget, category, occasion, style, priority), recommend the best matching products from the provided catalog.

Rules:
- Return ONLY valid JSON — no markdown, no explanation outside JSON
- Recommend 3-5 products max
- Each recommendation needs: productSlug, reason (1 sentence), score (0-100)
- Score based on how well the product matches their preferences
- If no products match well, return fewer recommendations with honest scores

Response format:
{
  "recommendations": [
      { "productSlug": "slug-here", "reason": "Why this matches", "score": 85 }
        ],
          "summary": "Brief 1-sentence summary of recommendations"
          }`;

// ═══════════════════════════════════════
// LLM PROVIDER FUNCTIONS
// ═══════════════════════════════════════

/**
 * Emergent.sh — OpenAI-compatible wrapper (Primary)
 * Uses OpenAI chat completions format via Emergent gateway
 */
async function chatWithEmergent(prompt) {
      const apiKey = process.env.EMERGENT_API_KEY || config.emergent?.apiKey;
      if (!apiKey) throw new Error('Emergent not configured');

  const baseUrl = process.env.EMERGENT_BASE_URL || 'https://api.emergent.sh/v1';
      const model = process.env.EMERGENT_MODEL || 'claude-sonnet-4-20250514';

  const response = await axios.post(`${baseUrl}/chat/completions`, {
          model,
          messages: [
              { role: 'system', content: RECOMMENDATION_PROMPT },
              { role: 'user', content: prompt },
                  ],
          max_tokens: 1024,
          temperature: 0.3,
  }, {
          headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
          },
          timeout: 20000,
  });

  return response.data.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Anthropic Claude (Fallback 1)
 */
async function chatWithAnthropic(prompt) {
      if (!config.anthropic?.apiKey) throw new Error('Anthropic not configured');

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: config.anthropic.model || 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: RECOMMENDATION_PROMPT,
          messages: [{ role: 'user', content: prompt }],
  }, {
          headers: {
                    'x-api-key': config.anthropic.apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
          },
          timeout: 20000,
  });

  return response.data.content?.[0]?.text?.trim() || '';
}

/**
 * DeepSeek (Fallback 2)
 */
async function chatWithDeepSeek(prompt) {
      if (!config.deepseek?.apiKey) throw new Error('DeepSeek not configured');

  const response = await axios.post(`${config.deepseek.baseUrl}/chat/completions`, {
          model: config.deepseek.model,
          messages: [
              { role: 'system', content: RECOMMENDATION_PROMPT },
              { role: 'user', content: prompt },
                  ],
  }, {
          headers: { Authorization: `Bearer ${config.deepseek.apiKey}` },
          timeout: 20000,
  });

  return response.data.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Gemini (Fallback 3)
 */
async function chatWithGemini(prompt) {
      if (!config.gemini?.apiKey) throw new Error('Gemini not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
      const response = await axios.post(url, {
              contents: [{ parts: [
                  { text: `${RECOMMENDATION_PROMPT}\n\n${prompt}` }
                      ]}],
      }, { timeout: 20000 });

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

/**
 * Call LLM with fallback chain: Emergent > Anthropic > DeepSeek > Gemini
 */
async function callLLM(prompt) {
      const providers = [
          { name: 'emergent', fn: chatWithEmergent },
          { name: 'anthropic', fn: chatWithAnthropic },
          { name: 'deepseek', fn: chatWithDeepSeek },
          { name: 'gemini', fn: chatWithGemini },
            ];

  for (const { name, fn } of providers) {
          try {
                    const result = await fn(prompt);
                    logger.info(`Recommendation: Response via ${name}`);
                    return { result, provider: name };
          } catch (err) {
                    logger.warn(`Recommendation: ${name} failed — ${err.message}`);
          }
  }

  throw new Error('All LLM providers failed');
}

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

/**
 * POST /api/chat/recommend — AI Product Recommendations
 * Body: { answers: { budget, category, occasion, style, priority } }
 * Saves session to DB for product optimization analytics
 */
router.post('/recommend', async (req, res) => {
      const startTime = Date.now();
      try {
              const { answers } = req.body;
              if (!answers || !answers.budget || !answers.category) {
                        return res.status(400).json({ error: 'Budget and category are required' });
              }

        // Fetch matching products from DB
        const filter = { isActive: true };
              if (answers.category !== 'all') filter.category = answers.category;

        const products = await Product.find(filter)
                .select('title slug sellingPriceAud category tags description')
                .limit(30)
                .lean();

        if (!products.length) {
                  return res.json({
                              recommendations: [],
                              summary: 'No products found in this category yet. Check back soon!',
                              sessionId: null,
                  });
        }

        // Build catalog string for LLM
        const catalog = products.map(p =>
                  `- ${p.title} (${p.slug}) | $${p.sellingPriceAud} AUD | ${p.category} | ${(p.tags || []).join(', ')}`
                                         ).join('\n');

        const prompt = `Customer preferences:
        - Budget: ${answers.budget}
        - Category: ${answers.category}
        - Occasion: ${answers.occasion || 'personal'}
        - Style: ${answers.style || 'modern'}
        - Priority: ${answers.priority || 'quality'}

        Available products:
        ${catalog}

        Recommend the best matches. Return JSON only.`;

        // Call LLM
        const { result: raw, provider } = await callLLM(prompt);

        // Parse AI response
        let parsed;
              try {
                        const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                        parsed = JSON.parse(jsonStr);
              } catch (parseErr) {
                        logger.warn('Failed to parse LLM JSON, using fallback', { raw: raw.substring(0, 200) });
                        parsed = {
                                    recommendations: products.slice(0, 3).map(p => ({
                                                  productSlug: p.slug,
                                                  reason: 'Top pick in your category',
                                                  score: 70,
                                    })),
                                    summary: 'Here are our top picks for you!',
                        };
              }

        // Enrich recommendations with full product data
        const enriched = [];
              for (const rec of (parsed.recommendations || [])) {
                        const product = products.find(p => p.slug === rec.productSlug);
                        if (product) {
                                    enriched.push({
                                                  productId: product._id,
                                                  productSlug: product.slug,
                                                  productTitle: product.title,
                                                  reason: rec.reason,
                                                  score: rec.score || 50,
                                                  priceAud: product.sellingPriceAud,
                                                  category: product.category,
                                    });
                        }
              }

        // Save recommendation session to DB
        const sessionId = crypto.randomUUID();
              const ipHash = crypto.createHash('sha256')
                .update(req.ip || 'unknown')
                .digest('hex')
                .substring(0, 16);

        const session = new RecommendationSession({
                  sessionId,
                  answers,
                  recommendations: enriched,
                  provider,
                  aiModel: provider === 'emergent' ? (process.env.EMERGENT_MODEL || 'claude-sonnet-4-20250514') : undefined,
                  responseTimeMs: Date.now() - startTime,
                  ipHash,
                  userAgent: req.get('user-agent')?.substring(0, 200),
                  totalRecommendations: enriched.length,
        });
              await session.save();

        logger.info(`Recommendation session saved: ${sessionId} (${enriched.length} products, ${Date.now() - startTime}ms)`);

        res.json({
                  recommendations: enriched,
                  summary: parsed.summary || 'Here are your personalized picks!',
                  sessionId,
                  provider,
        });
      } catch (err) {
              logger.error('Recommendation error', { error: err.message });
              res.status(500).json({
                        error: 'Unable to generate recommendations right now',
                        recommendations: [],
              });
      }
});

/**
 * POST /api/chat/track — Track engagement on recommendations
 * Body: { sessionId, action: 'view'|'click'|'cart'|'purchase'|'dismiss', productId }
 */
router.post('/track', async (req, res) => {
      try {
              const { sessionId, action, productId } = req.body;
              if (!sessionId || !action || !productId) {
                        return res.status(400).json({ error: 'sessionId, action, and productId required' });
              }

        const fieldMap = {
                  view: 'engagement.viewedProducts',
                  click: 'engagement.clickedProducts',
                  cart: 'engagement.addedToCart',
                  purchase: 'engagement.purchased',
                  dismiss: 'engagement.dismissed',
        };

        const field = fieldMap[action];
              if (!field) return res.status(400).json({ error: 'Invalid action' });

        const update = { $addToSet: { [field]: productId } };
              if (action === 'purchase') update.$set = { conversionOccurred: true };

        await RecommendationSession.findOneAndUpdate({ sessionId }, update);
              res.json({ success: true });
      } catch (err) {
              logger.error('Track error', { error: err.message });
              res.status(500).json({ error: 'Failed to track' });
      }
});

/**
 * POST /api/chat/feedback — Save quiz feedback
 * Body: { sessionId, rating (1-5), text }
 */
router.post('/feedback', async (req, res) => {
      try {
              const { sessionId, rating, text } = req.body;
              if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

        await RecommendationSession.findOneAndUpdate({ sessionId }, {
                  feedbackRating: rating,
                  feedbackText: text?.substring(0, 500),
        });
              res.json({ success: true });
      } catch (err) {
              res.status(500).json({ error: 'Failed to save feedback' });
      }
});

/**
 * GET /api/chat/analytics — Product optimization insights
 * Returns aggregated data for product optimization
 */
router.get('/analytics', async (req, res) => {
      try {
              const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [topCategories, conversionRate, avgRating, topProducts] = await Promise.all([
                  // Most requested categories
                                                                                                RecommendationSession.aggregate([
                                                                                                    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                                                                                                    { $group: { _id: '$answers.category', count: { $sum: 1 } } },
                                                                                                    { $sort: { count: -1 } },
                                                                                                    { $limit: 10 },
                                                                                                          ]),

                  // Conversion rate
                  RecommendationSession.aggregate([
                      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                      { $group: {
                                    _id: null,
                                    total: { $sum: 1 },
                                    converted: { $sum: { $cond: ['$conversionOccurred', 1, 0] } },
                      }},
                            ]),

                  // Average feedback rating
                  RecommendationSession.aggregate([
                      { $match: { feedbackRating: { $exists: true }, createdAt: { $gte: thirtyDaysAgo } } },
                      { $group: { _id: null, avg: { $avg: '$feedbackRating' }, count: { $sum: 1 } } },
                            ]),

                  // Most recommended products
                  RecommendationSession.aggregate([
                      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                      { $unwind: '$recommendations' },
                      { $group: {
                                    _id: '$recommendations.productSlug',
                                    title: { $first: '$recommendations.productTitle' },
                                    timesRecommended: { $sum: 1 },
                                    avgScore: { $avg: '$recommendations.score' },
                      }},
                      { $sort: { timesRecommended: -1 } },
                      { $limit: 20 },
                            ]),
                ]);

        const conv = conversionRate[0] || { total: 0, converted: 0 };
              const rating = avgRating[0] || { avg: 0, count: 0 };

        res.json({
                  period: '30d',
                  totalSessions: conv.total,
                  conversionRate: conv.total ? ((conv.converted / conv.total) * 100).toFixed(1) + '%' : '0%',
                  avgFeedbackRating: rating.avg?.toFixed(1) || 'N/A',
                  feedbackCount: rating.count,
                  topCategories,
                  topProducts,
                  insights: {
                              budgetDistribution: await RecommendationSession.aggregate([
                                  { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                                  { $group: { _id: '$answers.budget', count: { $sum: 1 } } },
                                  { $sort: { count: -1 } },
                                          ]),
                              priorityDistribution: await RecommendationSession.aggregate([
                                  { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                                  { $group: { _id: '$answers.priority', count: { $sum: 1 } } },
                                  { $sort: { count: -1 } },
                                          ]),
                  },
        });
      } catch (err) {
              logger.error('Analytics error', { error: err.message });
              res.status(500).json({ error: 'Failed to fetch analytics' });
      }
});

/**
 * POST /api/chat — Legacy chat endpoint (kept for backward compat)
 * Now redirects to recommendation flow
 */
router.post('/', async (req, res) => {
      try {
              const { message, history } = req.body;
              if (!message) return res.status(400).json({ error: 'Message is required' });

        const prompt = `${RECOMMENDATION_PROMPT}\n\nCustomer says: "${message}"\n\nProvide a helpful, concise shopping response in plain text (not JSON). 2-3 sentences max.`;

        const { result, provider } = await callLLM(prompt);
              res.json({ reply: result, provider });
      } catch (err) {
              logger.error('Chat error', { error: err.message });
              res.json({
                        reply: "I'm having a moment — browse our shop or try again shortly! Email us at Xeriaco@outlook.com.",
                        provider: 'fallback',
              });
      }
});

module.exports = router;
