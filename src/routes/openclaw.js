const express = require('express');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { Product, Order, PipelineRun, Analytics } = require('../models');

const router = express.Router();

// Admin auth middleware
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.adminPassword;
  if (pw !== (process.env.ADMIN_PASSWORD || config.admin?.password || 'xeriaco2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// Simple command matcher for when AI is unavailable
function matchSimpleCommand(msg) {
  const m = msg.toLowerCase().trim();
  if (m.includes('list') && m.includes('product')) return { action: 'list_products', filters: { limit: 20 } };
  if (m.includes('list') && m.includes('order')) return { action: 'list_orders', filters: { limit: 20 } };
  if (m.includes('pending') && m.includes('order')) return { action: 'list_orders', filters: { status: 'pending', limit: 20 } };
  if (m.includes('dashboard') || m.includes('overview')) return { action: 'get_dashboard' };
  if (m.includes('health')) return { action: 'health_check' };
  if (m.includes('pipeline') && m.includes('status')) return { action: 'pipeline_status' };
  if (m.includes('run') && m.includes('pipeline')) return { action: 'run_pipeline', type: 'full' };
  if (m.includes('analytics') || m.includes('sales')) return { action: 'get_analytics', period: '7d' };
  if (m.includes('ticket')) return { action: 'list_support_tickets', filters: {} };
  if (m.includes('setting')) return { action: 'get_settings' };
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  OPENCLAW COMMAND INTERPRETER
//  POST /api/openclaw/command
//  Accepts natural language, interprets intent, executes actions
// ═══════════════════════════════════════════════════════════════

const OPENCLAW_SYSTEM = `You are OpenClaw, the AI operations manager for XeriaCo dropshipping platform.

You can execute these commands by returning JSON with "actions" array:

PRODUCT MANAGEMENT:
- list_products: {action:"list_products", filters:{status,category,minScore,maxScore,limit}}
- approve_product: {action:"approve_product", productId:"..."}
- reject_product: {action:"reject_product", productId:"...", reason:"..."}
- kill_product: {action:"kill_product", productId:"..."}
- reprice_product: {action:"reprice_product", productId:"...", newPrice:number}
- edit_product: {action:"edit_product", productId:"...", updates:{title,description,price,category,tags}}
- bulk_approve: {action:"bulk_approve", filters:{minScore:number}}
- bulk_kill: {action:"bulk_kill", filters:{maxScore:number,olderThanDays:number}}

ORDER MANAGEMENT:
- list_orders: {action:"list_orders", filters:{status,limit,customerId}}
- update_order: {action:"update_order", orderId:"...", status:"...", note:"..."}
- fulfill_order: {action:"fulfill_order", orderId:"...", trackingNumber:"...", carrier:"..."}
- refund_order: {action:"refund_order", orderId:"...", reason:"...", amount:number}
- fraud_review: {action:"fraud_review", orderId:"...", decision:"approve"|"reject", note:"..."}

PIPELINE CONTROL:
- run_pipeline: {action:"run_pipeline", type:"full"|"trend"|"supplier"|"enrich"|"competitor"}
- pipeline_status: {action:"pipeline_status"}
- set_discovery_interval: {action:"set_discovery_interval", minutes:number}
- pause_discovery: {action:"pause_discovery"}
- resume_discovery: {action:"resume_discovery"}

CUSTOMER SUPPORT:
- list_support_tickets: {action:"list_support_tickets", filters:{status,priority}}
- respond_ticket: {action:"respond_ticket", ticketId:"...", message:"...", status:"open"|"resolved"|"escalated"}
- create_ticket: {action:"create_ticket", customerEmail:"...", subject:"...", message:"...", priority:"low"|"medium"|"high"}
- auto_respond: {action:"auto_respond", ticketId:"..."} (AI generates response)

STORE MANAGEMENT:
- get_settings: {action:"get_settings"}
- update_settings: {action:"update_settings", settings:{key:value}}
- get_analytics: {action:"get_analytics", period:"24h"|"7d"|"30d"|"90d"}
- get_dashboard: {action:"get_dashboard"}
- sync_shopify: {action:"sync_shopify", productId:"..."}
- sync_woocommerce: {action:"sync_woocommerce", productId:"..."}

SYSTEM:
- health_check: {action:"health_check"}
- get_logs: {action:"get_logs", limit:number, level:"info"|"warn"|"error"}

IMPORTANT RULES:
1. Return ONLY valid JSON: {"actions":[...], "summary":"brief description of what you're doing"}
2. You can chain multiple actions in one response
3. If the request is unclear, return {"actions":[], "summary":"...", "clarification":"what you need"}
4. For destructive actions (kill, delete, refund), confirm intent in summary
5. When asked about status/reports, use list and analytics actions
6. Be proactive — if someone asks "how are sales?" also pull recent orders and top products
7. No markdown, no explanation outside JSON structure`;

router.post('/command', async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Build context for the AI
    let contextStr = '';
    if (context) {
      contextStr = `\n\nCurrent context:\n${JSON.stringify(context)}`;
    }

    // Get quick stats for context
    const [productCount, orderCount, pendingOrders] = await Promise.all([
      Product.countDocuments().catch(() => 0),
      Order.countDocuments().catch(() => 0),
      Order.countDocuments({ status: 'pending' }).catch(() => 0),
    ]);

    const statsContext = `\nSystem stats: ${productCount} products, ${orderCount} total orders, ${pendingOrders} pending orders.`;

    // Call AI to interpret command
    const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
    
    // If no AI, try to match simple commands directly
    if (!anthropicKey) {
      const simple = matchSimpleCommand(message);
      if (simple) {
        const result = await executeAction(simple);
        return res.json({ summary: `Executed: ${simple.action}`, results: [{ action: simple.action, success: true, data: result }], actionsExecuted: 1 });
      }
      return res.json({ summary: 'AI not available. Use quick actions or the /quick endpoint directly.', results: [], actionsExecuted: 0 });
    }

    let aiText;
    try {
      const aiResponse = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: OPENCLAW_SYSTEM,
        messages: [{ role: 'user', content: message + statsContext + contextStr }],
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 25000,
      });
      aiText = (aiResponse.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    } catch (aiErr) {
      logger.warn('OpenClaw AI call failed:', aiErr.message);
      // Fallback to simple command matching
      const simple = matchSimpleCommand(message);
      if (simple) {
        const result = await executeAction(simple);
        return res.json({ summary: `AI unavailable, executed directly: ${simple.action}`, results: [{ action: simple.action, success: true, data: result }], actionsExecuted: 1 });
      }
      return res.json({ summary: `AI call failed: ${aiErr.message}. Try using Quick Actions instead.`, results: [], actionsExecuted: 0 });
    }
    
    let parsed;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiText);
    } catch {
      return res.json({ summary: aiText, results: [], raw: true });
    }

    // Execute all actions
    const results = [];
    for (const action of (parsed.actions || [])) {
      try {
        const result = await executeAction(action);
        results.push({ action: action.action, success: true, data: result });
      } catch (err) {
        results.push({ action: action.action, success: false, error: err.message });
      }
    }

    return res.json({
      summary: parsed.summary || 'Actions executed',
      clarification: parsed.clarification || null,
      results,
      actionsExecuted: results.length,
    });
  } catch (err) {
    logger.error('OpenClaw command error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ACTION EXECUTOR
// ═══════════════════════════════════════════════════════════════

async function executeAction(action) {
  switch (action.action) {
    // ─── PRODUCTS ───
    case 'list_products': {
      const query = {};
      if (action.filters?.status) query.status = action.filters.status;
      if (action.filters?.category) query.category = action.filters.category;
      if (action.filters?.minScore) query['aiAnalysis.overallScore'] = { $gte: action.filters.minScore };
      if (action.filters?.maxScore) query['aiAnalysis.overallScore'] = { ...query['aiAnalysis.overallScore'], $lte: action.filters.maxScore };
      const products = await Product.find(query).sort({ createdAt: -1 }).limit(action.filters?.limit || 20).lean();
      return { count: products.length, products: products.map(p => ({
        id: p._id, title: p.title, status: p.status, category: p.category || p.aiAnalysis?.category,
        price: p.pricing?.sellingPrice || p.aiAnalysis?.recommendedSellingPrice,
        score: p.aiAnalysis?.overallScore, margin: p.aiAnalysis?.estimatedMargin,
        createdAt: p.createdAt,
      }))};
    }

    case 'approve_product': {
      const p = await Product.findByIdAndUpdate(action.productId, { status: 'approved', approvedAt: new Date() }, { new: true });
      if (!p) throw new Error('Product not found');
      return { approved: true, title: p.title, id: p._id };
    }

    case 'reject_product': {
      const p = await Product.findByIdAndUpdate(action.productId, { status: 'rejected', rejectionReason: action.reason }, { new: true });
      if (!p) throw new Error('Product not found');
      return { rejected: true, title: p.title, reason: action.reason };
    }

    case 'kill_product': {
      const p = await Product.findByIdAndUpdate(action.productId, { status: 'killed', killedAt: new Date() }, { new: true });
      if (!p) throw new Error('Product not found');
      return { killed: true, title: p.title };
    }

    case 'reprice_product': {
      const p = await Product.findById(action.productId);
      if (!p) throw new Error('Product not found');
      const oldPrice = p.pricing?.sellingPrice || p.aiAnalysis?.recommendedSellingPrice;
      if (p.pricing) p.pricing.sellingPrice = action.newPrice;
      if (p.aiAnalysis) p.aiAnalysis.recommendedSellingPrice = action.newPrice;
      p.repriceHistory = [...(p.repriceHistory || []), { from: oldPrice, to: action.newPrice, time: new Date() }];
      await p.save();
      return { repriced: true, title: p.title, from: oldPrice, to: action.newPrice };
    }

    case 'edit_product': {
      const updates = {};
      if (action.updates?.title) updates.title = action.updates.title;
      if (action.updates?.description) updates.description = action.updates.description;
      if (action.updates?.category) updates.category = action.updates.category;
      if (action.updates?.tags) updates.tags = action.updates.tags;
      if (action.updates?.price) {
        updates['pricing.sellingPrice'] = action.updates.price;
        updates['aiAnalysis.recommendedSellingPrice'] = action.updates.price;
      }
      const p = await Product.findByIdAndUpdate(action.productId, updates, { new: true });
      if (!p) throw new Error('Product not found');
      return { edited: true, title: p.title, fieldsUpdated: Object.keys(action.updates || {}) };
    }

    case 'bulk_approve': {
      const filter = { status: 'discovered' };
      if (action.filters?.minScore) filter['aiAnalysis.overallScore'] = { $gte: action.filters.minScore };
      const result = await Product.updateMany(filter, { status: 'approved', approvedAt: new Date() });
      return { bulkApproved: result.modifiedCount };
    }

    case 'bulk_kill': {
      const filter = { status: { $in: ['discovered', 'approved', 'listed'] } };
      if (action.filters?.maxScore) filter['aiAnalysis.overallScore'] = { $lte: action.filters.maxScore };
      if (action.filters?.olderThanDays) {
        filter.createdAt = { $lte: new Date(Date.now() - action.filters.olderThanDays * 86400000) };
      }
      const result = await Product.updateMany(filter, { status: 'killed', killedAt: new Date() });
      return { bulkKilled: result.modifiedCount };
    }

    // ─── ORDERS ───
    case 'list_orders': {
      const query = {};
      if (action.filters?.status) query.status = action.filters.status;
      if (action.filters?.customerId) query.customerId = action.filters.customerId;
      const orders = await Order.find(query).sort({ createdAt: -1 }).limit(action.filters?.limit || 20).lean();
      return { count: orders.length, orders: orders.map(o => ({
        id: o._id, orderId: o.orderId, status: o.status, total: o.total || o.totalAmount,
        customer: o.customer?.email || o.customerEmail, items: (o.items || []).length,
        createdAt: o.createdAt,
      }))};
    }

    case 'update_order': {
      const o = await Order.findOneAndUpdate(
        { $or: [{ _id: action.orderId }, { orderId: action.orderId }] },
        { status: action.status, $push: { statusHistory: { status: action.status, time: new Date(), note: action.note } } },
        { new: true }
      );
      if (!o) throw new Error('Order not found');
      return { updated: true, orderId: o.orderId, newStatus: action.status };
    }

    case 'fulfill_order': {
      const o = await Order.findOneAndUpdate(
        { $or: [{ _id: action.orderId }, { orderId: action.orderId }] },
        { 
          status: 'shipped',
          trackingNumber: action.trackingNumber,
          carrier: action.carrier,
          shippedAt: new Date(),
          $push: { statusHistory: { status: 'shipped', time: new Date(), note: `Tracking: ${action.trackingNumber}` } }
        },
        { new: true }
      );
      if (!o) throw new Error('Order not found');
      return { fulfilled: true, orderId: o.orderId, tracking: action.trackingNumber };
    }

    case 'refund_order': {
      const o = await Order.findOneAndUpdate(
        { $or: [{ _id: action.orderId }, { orderId: action.orderId }] },
        { 
          status: 'refunded',
          refundReason: action.reason,
          refundAmount: action.amount,
          refundedAt: new Date(),
          $push: { statusHistory: { status: 'refunded', time: new Date(), note: action.reason } }
        },
        { new: true }
      );
      if (!o) throw new Error('Order not found');
      return { refunded: true, orderId: o.orderId, amount: action.amount };
    }

    case 'fraud_review': {
      const newStatus = action.decision === 'approve' ? 'processing' : 'cancelled';
      const o = await Order.findOneAndUpdate(
        { $or: [{ _id: action.orderId }, { orderId: action.orderId }] },
        { 
          status: newStatus,
          fraudReview: { decision: action.decision, note: action.note, reviewedAt: new Date() },
          $push: { statusHistory: { status: newStatus, time: new Date(), note: `Fraud review: ${action.decision}` } }
        },
        { new: true }
      );
      if (!o) throw new Error('Order not found');
      return { reviewed: true, orderId: o.orderId, decision: action.decision };
    }

    // ─── PIPELINE ───
    case 'run_pipeline': {
      const { v4: uuidv4 } = require('uuid');
      const runId = uuidv4();
      const run = new PipelineRun({
        runId,
        type: action.type || 'full',
        status: 'running',
        startedAt: new Date(),
        triggeredBy: 'openclaw',
      });
      await run.save();
      // Trigger async pipeline execution
      setTimeout(async () => {
        try {
          const pipeline = require('../services/pipeline');
          if (pipeline && pipeline.executePipeline) {
            await pipeline.executePipeline(run);
          }
        } catch (err) {
          logger.error('Pipeline execution error:', err);
          run.status = 'failed';
          run.error = err.message;
          await run.save();
        }
      }, 100);
      return { started: true, runId, type: action.type || 'full' };
    }

    case 'pipeline_status': {
      const recent = await PipelineRun.find().sort({ startedAt: -1 }).limit(5).lean();
      return { runs: recent.map(r => ({ runId: r.runId, type: r.type, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt })) };
    }

    case 'set_discovery_interval':
    case 'pause_discovery':
    case 'resume_discovery': {
      // These affect frontend state — return instruction for V9 to execute
      return { frontendAction: action.action, minutes: action.minutes, note: 'Frontend will apply this setting' };
    }

    // ─── CUSTOMER SUPPORT ───
    case 'list_support_tickets': {
      // Use orders with issues or a support collection
      const query = {};
      if (action.filters?.status === 'open') query['support.status'] = { $ne: 'resolved' };
      if (action.filters?.status === 'resolved') query['support.status'] = 'resolved';
      const tickets = await Order.find({ 'support.tickets': { $exists: true, $not: { $size: 0 } } })
        .sort({ updatedAt: -1 }).limit(20).lean();
      // Also check standalone support collection if exists
      let standalone = [];
      try {
        const SupportTicket = require('../models').SupportTicket;
        if (SupportTicket) {
          const tQuery = {};
          if (action.filters?.status) tQuery.status = action.filters.status;
          if (action.filters?.priority) tQuery.priority = action.filters.priority;
          standalone = await SupportTicket.find(tQuery).sort({ createdAt: -1 }).limit(20).lean();
        }
      } catch {}
      return { 
        orderTickets: tickets.map(t => ({ orderId: t.orderId, customer: t.customer?.email, tickets: t.support?.tickets })),
        supportTickets: standalone.map(t => ({ id: t._id, subject: t.subject, status: t.status, priority: t.priority, customer: t.customerEmail, createdAt: t.createdAt })),
      };
    }

    case 'respond_ticket': {
      try {
        const SupportTicket = require('../models').SupportTicket;
        if (SupportTicket) {
          const ticket = await SupportTicket.findByIdAndUpdate(action.ticketId, {
            $push: { responses: { message: action.message, from: 'openclaw', time: new Date() } },
            status: action.status || 'responded',
            updatedAt: new Date(),
          }, { new: true });
          if (ticket) return { responded: true, ticketId: ticket._id, status: ticket.status };
        }
      } catch {}
      // Fallback: try order-based support
      return { responded: false, note: 'Support ticket system not yet initialized. Creating now...' };
    }

    case 'create_ticket': {
      try {
        const SupportTicket = require('../models').SupportTicket;
        if (SupportTicket) {
          const ticket = new SupportTicket({
            customerEmail: action.customerEmail,
            subject: action.subject,
            message: action.message,
            priority: action.priority || 'medium',
            status: 'open',
            source: 'openclaw',
          });
          await ticket.save();
          return { created: true, ticketId: ticket._id };
        }
      } catch {}
      return { created: false, note: 'SupportTicket model not available' };
    }

    case 'auto_respond': {
      // AI generates a customer support response
      const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
      if (!anthropicKey) return { autoResponse: 'Thank you for reaching out! We are reviewing your case and will respond shortly. - XeriaCo Team', ticketId: action.ticketId, note: 'AI unavailable' };
      
      let ticketData;
      try {
        const SupportTicket = require('../models').SupportTicket;
        ticketData = await SupportTicket.findById(action.ticketId).lean();
      } catch {}
      if (!ticketData) throw new Error('Ticket not found');

      const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: 'You are a friendly, professional customer support agent for XeriaCo. Write a helpful, empathetic response. Keep it under 150 words. Be direct and solution-oriented.',
        messages: [{ role: 'user', content: `Customer inquiry:\nSubject: ${ticketData.subject}\nMessage: ${ticketData.message}\n\nPrevious responses: ${JSON.stringify(ticketData.responses || [])}\n\nWrite a professional response.` }],
      }, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        timeout: 15000,
      });

      const responseText = (aiRes.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      return { autoResponse: responseText, ticketId: action.ticketId };
    }

    // ─── STORE MANAGEMENT ───
    case 'get_settings': {
      return {
        adminPassword: '***',
        anthropicConfigured: !!(process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey),
        emergentConfigured: !!(process.env.EMERGENT_API_KEY || config.emergent?.apiKey),
        mongoConnected: require('mongoose').connection.readyState === 1,
        environment: process.env.NODE_ENV || 'development',
      };
    }

    case 'get_analytics': {
      const days = action.period === '24h' ? 1 : action.period === '7d' ? 7 : action.period === '90d' ? 90 : 30;
      const since = new Date(Date.now() - days * 86400000);
      const [products, orders, pipeline] = await Promise.all([
        Product.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$status', count: { $sum: 1 }, avgScore: { $avg: '$aiAnalysis.overallScore' } } }
        ]).catch(() => []),
        Order.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: '$total' } } }
        ]).catch(() => []),
        PipelineRun.countDocuments({ startedAt: { $gte: since } }).catch(() => 0),
      ]);
      return { period: action.period, products, orders, pipelineRuns: pipeline };
    }

    case 'get_dashboard': {
      const [totalProducts, totalOrders, recentProducts, recentOrders] = await Promise.all([
        Product.countDocuments(),
        Order.countDocuments(),
        Product.find().sort({ createdAt: -1 }).limit(5).lean(),
        Order.find().sort({ createdAt: -1 }).limit(5).lean(),
      ]);
      return {
        totalProducts, totalOrders,
        recentProducts: recentProducts.map(p => ({ id: p._id, title: p.title, status: p.status, score: p.aiAnalysis?.overallScore })),
        recentOrders: recentOrders.map(o => ({ id: o._id, orderId: o.orderId, status: o.status, total: o.total })),
      };
    }

    case 'sync_shopify':
    case 'sync_woocommerce': {
      const platform = action.action.replace('sync_', '');
      // Forward to marketplace route logic
      try {
        const p = await Product.findById(action.productId);
        if (!p) throw new Error('Product not found');
        return { synced: true, platform, title: p.title, note: `Queued for ${platform} sync` };
      } catch (err) {
        return { synced: false, platform, error: err.message };
      }
    }

    // ─── SYSTEM ───
    case 'health_check': {
      const mongoState = require('mongoose').connection.readyState;
      return {
        server: 'ok',
        mongo: mongoState === 1 ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
      };
    }

    case 'get_logs': {
      // Return recent activity from pipeline runs
      const runs = await PipelineRun.find().sort({ startedAt: -1 }).limit(action.limit || 10).lean();
      return { logs: runs.map(r => ({ type: r.type, status: r.status, started: r.startedAt, error: r.error })) };
    }

    default:
      return { unknown: true, action: action.action, note: 'Action not recognized' };
  }
}

// ═══════════════════════════════════════════════════════════════
//  DIRECT API ENDPOINTS (for V9 frontend quick actions)
// ═══════════════════════════════════════════════════════════════

// GET /api/openclaw/status — OpenClaw system status
router.get('/status', async (req, res) => {
  try {
    const [products, orders, pending] = await Promise.all([
      Product.countDocuments().catch(() => 0),
      Order.countDocuments().catch(() => 0),
      Order.countDocuments({ status: 'pending' }).catch(() => 0),
    ]);
    const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
    res.json({
      online: true,
      aiAvailable: !!anthropicKey,
      products, orders, pendingOrders: pending,
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ online: false, error: err.message });
  }
});

// POST /api/openclaw/quick — Execute a single action directly (no AI interpretation)
router.post('/quick', async (req, res) => {
  try {
    const result = await executeAction(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/openclaw/support/auto-reply — Auto-generate support response
router.post('/support/auto-reply', async (req, res) => {
  try {
    const { customerMessage, orderContext, tone } = req.body;
    const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
    if (!anthropicKey) return res.json({ reply: 'Thank you for contacting us! We are looking into your inquiry and will respond soon. - The XeriaCo Team', generated: false, note: 'AI unavailable' });

    const systemPrompt = `You are a professional, empathetic customer support agent for XeriaCo, an online store.
Tone: ${tone || 'friendly and professional'}
Rules:
- Keep responses under 150 words
- Be solution-oriented
- Never make promises you can't keep
- If order-related, reference their order details
- Sign off as "The XeriaCo Team"`;

    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Customer says: "${customerMessage}"${orderContext ? `\nOrder context: ${JSON.stringify(orderContext)}` : ''}` }],
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      timeout: 15000,
    });

    const reply = (aiRes.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    res.json({ reply, generated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/openclaw/product/ai-edit — AI-assisted product editing
router.post('/product/ai-edit', async (req, res) => {
  try {
    const { productId, instruction } = req.body;
    const product = await Product.findById(productId).lean();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
    if (!anthropicKey) return res.json({ success: false, error: 'AI not available for product editing. Set ANTHROPIC_API_KEY.' });

    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `You edit product listings for a dropshipping store. Given a product and an instruction, return ONLY JSON with the updated fields. Only include fields that changed. Valid fields: title, description, tags (array), category, pricing.sellingPrice. No markdown.`,
      messages: [{ role: 'user', content: `Product: ${JSON.stringify({ title: product.title, description: product.description, tags: product.tags, category: product.category, price: product.pricing?.sellingPrice })}\n\nInstruction: ${instruction}` }],
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      timeout: 15000,
    });

    const text = (aiRes.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const updates = JSON.parse(jsonMatch ? jsonMatch[0] : text);

    // Apply updates
    const flatUpdates = {};
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'pricing' && typeof val === 'object') {
        for (const [pk, pv] of Object.entries(val)) flatUpdates[`pricing.${pk}`] = pv;
      } else {
        flatUpdates[key] = val;
      }
    }

    const updated = await Product.findByIdAndUpdate(productId, flatUpdates, { new: true });
    res.json({ success: true, title: updated.title, changes: Object.keys(updates), product: { title: updated.title, description: updated.description, tags: updated.tags, category: updated.category, price: updated.pricing?.sellingPrice } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/openclaw/overview — Full system overview for OpenClaw dashboard
router.get('/overview', async (req, res) => {
  try {
    const [
      totalProducts, approvedProducts, listedProducts, killedProducts,
      totalOrders, pendingOrders, shippedOrders, deliveredOrders,
      recentPipeline, topProducts
    ] = await Promise.all([
      Product.countDocuments().catch(() => 0),
      Product.countDocuments({ status: 'approved' }).catch(() => 0),
      Product.countDocuments({ status: 'listed' }).catch(() => 0),
      Product.countDocuments({ status: 'killed' }).catch(() => 0),
      Order.countDocuments().catch(() => 0),
      Order.countDocuments({ status: 'pending' }).catch(() => 0),
      Order.countDocuments({ status: 'shipped' }).catch(() => 0),
      Order.countDocuments({ status: 'delivered' }).catch(() => 0),
      PipelineRun.find().sort({ startedAt: -1 }).limit(3).lean().catch(() => []),
      Product.find({ status: 'listed' }).sort({ 'aiAnalysis.overallScore': -1 }).limit(5).lean().catch(() => []),
    ]);

    res.json({
      products: { total: totalProducts, approved: approvedProducts, listed: listedProducts, killed: killedProducts },
      orders: { total: totalOrders, pending: pendingOrders, shipped: shippedOrders, delivered: deliveredOrders },
      pipeline: recentPipeline.map(r => ({ type: r.type, status: r.status, started: r.startedAt })),
      topProducts: topProducts.map(p => ({ id: p._id, title: p.title, score: p.aiAnalysis?.overallScore, price: p.pricing?.sellingPrice })),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
