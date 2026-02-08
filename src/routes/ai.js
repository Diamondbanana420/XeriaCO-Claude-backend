const express = require('express');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

const router = express.Router();

// Admin auth middleware
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.adminPassword;
  if (pw !== (process.env.ADMIN_PASSWORD || config.admin?.password || 'xeriaco2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ═══════════════════════════════════════
// POST /api/ai/chat — Generic AI proxy for V9 dashboard
// Accepts: { system, message, search, model }
// Returns: { content: string }
// ═══════════════════════════════════════
router.post('/chat', requireAdmin, async (req, res) => {
  try {
    const { system, message, search = false, model } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Try Anthropic direct first
    const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
    if (anthropicKey) {
      try {
        const body = {
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: system || 'You are a helpful assistant.',
          messages: [{ role: 'user', content: message }],
        };
        if (search) {
          body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
        }

        const response = await axios.post('https://api.anthropic.com/v1/messages', body, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          timeout: 120000,
        });

        const text = (response.data.content || [])
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('');

        return res.json({ content: text, provider: 'anthropic' });
      } catch (err) {
        logger.warn('Anthropic call failed, trying Emergent fallback:', err.message);
      }
    }

    // Fallback to Emergent
    const emergentKey = process.env.EMERGENT_API_KEY || config.emergent?.apiKey;
    if (emergentKey) {
      try {
        const baseUrl = process.env.EMERGENT_BASE_URL || 'https://api.emergent.sh/v1';
        const emergentModel = process.env.EMERGENT_MODEL || 'claude-sonnet-4-20250514';

        const response = await axios.post(`${baseUrl}/chat/completions`, {
          model: emergentModel,
          messages: [
            { role: 'system', content: system || 'You are a helpful assistant.' },
            { role: 'user', content: message },
          ],
          max_tokens: 2048,
        }, {
          headers: {
            'Authorization': `Bearer ${emergentKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 120000,
        });

        const text = response.data.choices?.[0]?.message?.content || '';
        return res.json({ content: text, provider: 'emergent' });
      } catch (err) {
        logger.warn('Emergent call failed:', err.message);
      }
    }

    return res.status(503).json({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY or EMERGENT_API_KEY.' });
  } catch (err) {
    logger.error('AI proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/status — Check AI provider availability
router.get('/status', requireAdmin, (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
  const emergentKey = process.env.EMERGENT_API_KEY || config.emergent?.apiKey;

  res.json({
    anthropic: !!anthropicKey,
    emergent: !!emergentKey,
    available: !!(anthropicKey || emergentKey),
  });
});

module.exports = router;
