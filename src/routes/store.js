const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { Product, Order, SupportTicket } = require('../models');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════
//  PUBLIC STOREFRONT API — No auth required for customer access
// ═══════════════════════════════════════════════════════════════

// GET /api/store/products — Customer-facing product catalog
router.get('/products', async (req, res) => {
  try {
    const { category, search, sort = 'newest', page = 1, limit = 20 } = req.query;

    const filter = { 
      isActive: { $ne: false },
      sellingPriceAud: { $gt: 0 },
    };
    if (category && category !== 'all') filter.category = category;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const sortMap = {
      newest: { createdAt: -1 },
      price_low: { sellingPriceAud: 1 },
      price_high: { sellingPriceAud: -1 },
      popular: { 'aiAnalysis.overallScore': -1 },
      name: { title: 1 },
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [products, total, categories] = await Promise.all([
      Product.find(filter).sort(sortMap[sort] || sortMap.newest).skip(skip).limit(parseInt(limit)).lean(),
      Product.countDocuments(filter),
      Product.distinct('category', { isActive: { $ne: false }, sellingPriceAud: { $gt: 0 } }),
    ]);

    const catalog = products.map(p => ({
      id: p._id,
      slug: p.shopifyHandle || p._id.toString(),
      title: p.title,
      description: p.description || p.aiAnalysis?.description || '',
      category: p.category || 'General',
      price: p.sellingPriceAud || 0,
      comparePrice: p.comparePriceAud || Math.round((p.sellingPriceAud || 0) * 1.35),
      image: p.featuredImage || p.images?.[0]?.url || p.images?.[0] || null,
      images: (p.images || []).map(i => typeof i === 'string' ? i : i?.url || ''),
      tags: p.tags || [],
      rating: p.aiAnalysis?.overallScore ? Math.min(5, (p.aiAnalysis.overallScore / 20).toFixed(1)) : 4.5,
      reviewCount: hashToReviews(p._id.toString()),
      inStock: true,
      badge: p.aiAnalysis?.overallScore >= 80 ? 'Hot' : p.createdAt > new Date(Date.now() - 7*86400000) ? 'New' : null,
      vendor: p.vendor || 'XeriaCO',
    }));

    res.json({
      products: catalog,
      categories: ['all', ...categories.filter(Boolean)],
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    logger.error('Store catalog error:', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// GET /api/store/products/:id — Single product detail
router.get('/products/:id', async (req, res) => {
  try {
    const p = await Product.findById(req.params.id).lean();
    if (!p) return res.status(404).json({ error: 'Product not found' });

    res.json({
      id: p._id,
      title: p.title,
      description: p.description || p.aiAnalysis?.description || '',
      descriptionHtml: p.descriptionHtml || '',
      category: p.category || 'General',
      price: p.sellingPriceAud || 0,
      comparePrice: p.comparePriceAud || Math.round((p.sellingPriceAud || 0) * 1.35),
      image: p.featuredImage || p.images?.[0]?.url || p.images?.[0] || null,
      images: (p.images || []).map(i => typeof i === 'string' ? i : i?.url || ''),
      tags: p.tags || [],
      rating: p.aiAnalysis?.overallScore ? Math.min(5, (p.aiAnalysis.overallScore / 20).toFixed(1)) : 4.5,
      reviewCount: hashToReviews(p._id.toString()),
      inStock: true,
      vendor: p.vendor || 'XeriaCO',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// POST /api/store/orders — Create a new order
router.post('/orders', async (req, res) => {
  try {
    const { items, customer, shippingAddress } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'No items in order' });
    if (!customer?.email) return res.status(400).json({ error: 'Customer email required' });

    const orderItems = [];
    let subtotal = 0;
    let totalCost = 0;

    for (const item of items) {
      const product = await Product.findById(item.productId).lean();
      if (!product) continue;

      const price = product.sellingPriceAud || 0;
      const cost = product.costUsd || product.totalCostUsd || 0;
      const qty = Math.max(1, Math.min(10, item.quantity || 1));

      orderItems.push({
        productId: product._id,
        title: product.title,
        quantity: qty,
        priceAud: price,
        costUsd: cost,
      });

      subtotal += price * qty;
      totalCost += cost * qty;
    }

    if (!orderItems.length) return res.status(400).json({ error: 'No valid products found' });

    const shipping = subtotal >= 100 ? 0 : 9.95;
    const tax = Math.round(subtotal * 0.1 * 100) / 100;
    const total = Math.round((subtotal + shipping + tax) * 100) / 100;

    // Generate unique order ID compatible with Order model (shopifyOrderId is required)
    const orderId = `XCO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

    const nameParts = (customer.name || '').split(' ');

    const order = new Order({
      shopifyOrderId: orderId,
      shopifyOrderNumber: orderId,
      shopifyOrderName: `#${orderId}`,
      status: 'new',
      statusHistory: [{ status: 'new', changedAt: new Date(), note: 'Order placed via XeriaCO storefront' }],
      customer: {
        email: customer.email,
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        country: shippingAddress?.country || 'AU',
        state: shippingAddress?.state || shippingAddress?.city || '',
      },
      items: orderItems,
      financials: {
        subtotalAud: subtotal,
        shippingAud: shipping,
        taxAud: tax,
        totalAud: total,
        totalCostUsd: totalCost,
      },
      tags: ['storefront'],
      notes: `Storefront order | ${shippingAddress?.address || ''}, ${shippingAddress?.city || ''} ${shippingAddress?.zip || ''}`,
    });

    await order.save();

    // Discord notification
    try {
      const discordWh = process.env.DISCORD_WEBHOOK;
      if (discordWh) {
        const axios = require('axios');
        await axios.post(discordWh, {
          content: `🛒 **New Order!** ${orderId}\n💰 $${total.toFixed(2)} | ${orderItems.length} items\n📧 ${customer.email}\n📦 ${orderItems.map(i => i.title).join(', ')}`,
        }).catch(() => {});
      }
    } catch {}

    logger.info(`Store order created: ${orderId} — $${total}`);

    res.json({
      success: true,
      orderId,
      order: {
        id: order._id,
        orderId,
        items: orderItems.map(i => ({ title: i.title, price: i.priceAud, quantity: i.quantity })),
        subtotal,
        shipping,
        tax,
        total,
        status: 'new',
        estimatedDelivery: '7-14 business days',
      },
    });
  } catch (err) {
    logger.error('Store order error:', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to create order', detail: err.message });
  }
});

// GET /api/store/orders/:id — Customer order tracking
router.get('/orders/:id', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const id = req.params.id;
    
    // Build query - only include _id match if it's a valid ObjectId
    const query = { shopifyOrderId: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query.$or = [{ shopifyOrderId: id }, { _id: id }];
      delete query.shopifyOrderId;
    }
    
    const order = await Order.findOne(query).lean();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json({
      orderId: order.shopifyOrderId,
      status: order.status,
      items: (order.items || []).map(i => ({
        title: i.title,
        price: i.priceAud,
        quantity: i.quantity,
      })),
      subtotal: order.financials?.subtotalAud,
      shipping: order.financials?.shippingAud,
      tax: order.financials?.taxAud,
      total: order.financials?.totalAud,
      customer: { 
        name: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' '), 
        email: order.customer?.email 
      },
      trackingNumber: order.fulfillment?.trackingNumber,
      carrier: order.fulfillment?.carrier,
      statusHistory: (order.statusHistory || []).map(h => ({
        status: h.status,
        time: h.changedAt,
        note: h.note,
      })),
      createdAt: order.createdAt,
      estimatedDelivery: order.status === 'delivered' ? null : '7-14 business days',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// POST /api/store/support — Customer support ticket
router.post('/support', async (req, res) => {
  try {
    const { email, name, subject, message, orderId, category } = req.body;
    if (!email || !message) return res.status(400).json({ error: 'Email and message required' });

    const ticket = new SupportTicket({
      customerEmail: email,
      customerName: name || '',
      subject: subject || 'Customer Inquiry',
      message,
      orderId: orderId || null,
      category: category || (orderId ? 'order' : 'general'),
      priority: orderId ? 'medium' : 'low',
      status: 'open',
      source: 'storefront',
    });

    await ticket.save();

    // Try AI auto-respond
    try {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        const axios = require('axios');
        const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: 'You are a friendly customer support agent for XeriaCo online store. Write a brief, helpful acknowledgment (under 80 words). Sign off as "The XeriaCo Team".',
          messages: [{ role: 'user', content: `Customer ${name || email} wrote: "${message}"${orderId ? ` (re: order ${orderId})` : ''}. Acknowledge their inquiry.` }],
        }, {
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          timeout: 10000,
        });
        const reply = (aiRes.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        if (reply) {
          ticket.responses = [{ message: reply, from: 'openclaw', time: new Date(), isAiGenerated: true }];
          ticket.status = 'responded';
          await ticket.save();
        }
      }
    } catch {}

    res.json({
      success: true,
      ticketId: ticket._id,
      message: "Your inquiry has been received. We'll get back to you shortly!",
      autoResponse: ticket.responses?.[0]?.message || null,
    });
  } catch (err) {
    logger.error('Support ticket error:', err);
    res.status(500).json({ error: 'Failed to submit inquiry' });
  }
});

// GET /api/store/info — Store configuration
router.get('/info', async (req, res) => {
  try {
    const productCount = await Product.countDocuments({ 
      isActive: { $ne: false },
      sellingPriceAud: { $gt: 0 },
    });

    res.json({
      name: 'XeriaCO',
      tagline: 'Curated Quality Products, Delivered to Your Door',
      currency: 'AUD',
      currencySymbol: '$',
      freeShippingThreshold: 100,
      shippingCost: 9.95,
      taxRate: 0.10,
      taxLabel: 'GST',
      productCount,
      supportEmail: 'support@xeriaco.com',
      estimatedDelivery: '7-14 business days',
    });
  } catch (err) {
    res.json({ name: 'XeriaCO', currency: 'AUD', currencySymbol: '$' });
  }
});

function hashToReviews(id) {
  const h = crypto.createHash('md5').update(id).digest('hex');
  return 12 + (parseInt(h.slice(0, 4), 16) % 180);
}

module.exports = router;
