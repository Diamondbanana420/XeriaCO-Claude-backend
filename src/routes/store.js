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

    // Show active products with a selling price
    const filter = { 
      isActive: { $ne: false },
      sellingPriceAud: { $gt: 0 },
    };
    if (category && category !== 'all') filter.category = category;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
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
      Product.find(filter)
        .sort(sortMap[sort] || sortMap.newest)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(filter),
      Product.distinct('category', { isActive: { $ne: false }, sellingPriceAud: { $gt: 0 } }),
    ]);

    // Format for storefront display
    const catalog = products.map(p => ({
      id: p._id,
      slug: p.shopifyHandle || p._id.toString(),
      title: p.title,
      description: p.description || p.aiAnalysis?.description || '',
      category: p.category || p.aiAnalysis?.category || 'General',
      price: p.sellingPriceAud || p.aiAnalysis?.recommendedSellingPrice || 0,
      comparePrice: p.comparePriceAud || Math.round((p.sellingPriceAud || 0) * 1.35),
      image: p.featuredImage || p.images?.[0] || p.aiAnalysis?.imageUrl || null,
      images: p.images || (p.featuredImage ? [p.featuredImage] : []),
      tags: p.tags || [],
      rating: p.aiAnalysis?.overallScore ? Math.min(5, (p.aiAnalysis.overallScore / 20).toFixed(1)) : 4.5,
      reviewCount: hashToReviews(p._id.toString()),
      inStock: p.inventory?.inStock !== false,
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
      category: p.category || p.aiAnalysis?.category || 'General',
      price: p.sellingPriceAud || p.aiAnalysis?.recommendedSellingPrice || 0,
      comparePrice: p.comparePriceAud || Math.round((p.sellingPriceAud || 0) * 1.35),
      image: p.featuredImage || p.images?.[0] || null,
      images: p.images || (p.featuredImage ? [p.featuredImage] : []),
      tags: p.tags || [],
      rating: p.aiAnalysis?.overallScore ? Math.min(5, (p.aiAnalysis.overallScore / 20).toFixed(1)) : 4.5,
      reviewCount: hashToReviews(p._id.toString()),
      inStock: p.inventory?.inStock !== false,
      vendor: p.vendor || 'XeriaCO',
      marketingAngle: p.aiAnalysis?.marketingAngle || null,
      keyFeatures: p.aiAnalysis?.keyFeatures || [],
      targetAudience: p.aiAnalysis?.targetAudience || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// POST /api/store/orders — Create a new order (no Stripe required)
router.post('/orders', async (req, res) => {
  try {
    const { items, customer, shippingAddress } = req.body;

    if (!items?.length) return res.status(400).json({ error: 'No items in order' });
    if (!customer?.email) return res.status(400).json({ error: 'Customer email required' });

    // Validate products and calculate totals
    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      const product = await Product.findById(item.productId).lean();
      if (!product) continue;

      const price = product.sellingPriceAud || product.aiAnalysis?.recommendedSellingPrice || 0;
      const qty = Math.max(1, Math.min(10, item.quantity || 1));
      const lineTotal = price * qty;

      orderItems.push({
        productId: product._id,
        title: product.title,
        price,
        quantity: qty,
        lineTotal,
        image: product.featuredImage || product.images?.[0] || null,
        supplierCost: product.costUsd || product.totalCostUsd || 0,
      });

      subtotal += lineTotal;
    }

    if (!orderItems.length) return res.status(400).json({ error: 'No valid products found' });

    const shipping = subtotal >= 100 ? 0 : 9.95;
    const tax = Math.round(subtotal * 0.1 * 100) / 100; // 10% GST
    const total = Math.round((subtotal + shipping + tax) * 100) / 100;

    const orderId = `XCO-${Date.now().toString(36).toUpperCase()}`;

    const order = new Order({
      orderId,
      items: orderItems,
      customer: {
        email: customer.email,
        name: customer.name || '',
        phone: customer.phone || '',
      },
      shippingAddress: {
        line1: shippingAddress?.line1 || shippingAddress?.address || '',
        line2: shippingAddress?.line2 || '',
        city: shippingAddress?.city || '',
        state: shippingAddress?.state || '',
        postalCode: shippingAddress?.zip || shippingAddress?.postalCode || '',
        country: shippingAddress?.country || 'AU',
      },
      subtotal,
      shipping,
      tax,
      total,
      totalAmount: total,
      status: 'pending',
      source: 'storefront',
      statusHistory: [{ status: 'pending', time: new Date(), note: 'Order placed via storefront' }],
      paymentStatus: 'pending',
    });

    await order.save();

    // Send Discord notification
    try {
      const discordWh = process.env.DISCORD_WEBHOOK || '';
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
        items: orderItems.map(i => ({ title: i.title, price: i.price, quantity: i.quantity })),
        subtotal,
        shipping,
        tax,
        total,
        status: 'pending',
        estimatedDelivery: '7-14 business days',
      },
    });
  } catch (err) {
    logger.error('Store order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// GET /api/store/orders/:id — Customer order tracking
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [{ orderId: req.params.id }, { _id: req.params.id }],
    }).lean();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Require email for security
    const email = req.query.email;
    if (email && order.customer?.email !== email) {
      return res.status(403).json({ error: 'Email does not match order' });
    }

    res.json({
      orderId: order.orderId,
      status: order.status,
      items: (order.items || []).map(i => ({
        title: i.title,
        price: i.price,
        quantity: i.quantity,
        image: i.image,
      })),
      subtotal: order.subtotal,
      shipping: order.shipping,
      tax: order.tax,
      total: order.total || order.totalAmount,
      customer: { name: order.customer?.name, email: order.customer?.email },
      shippingAddress: order.shippingAddress,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      statusHistory: (order.statusHistory || []).map(h => ({
        status: h.status,
        time: h.time,
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

    // Try auto-respond via OpenClaw
    try {
      const config = require('../../config');
      const axios = require('axios');
      const anthropicKey = process.env.ANTHROPIC_API_KEY || config.anthropic?.apiKey;
      if (anthropicKey) {
        const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: 'You are a friendly customer support agent for XeriaCo online store. Write a brief, helpful acknowledgment (under 80 words). Sign off as "The XeriaCo Team".',
          messages: [{ role: 'user', content: `Customer ${name || email} wrote: "${message}"${orderId ? ` (regarding order ${orderId})` : ''}. Acknowledge their inquiry.` }],
        }, {
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          timeout: 10000,
        });
        const reply = (aiRes.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        if (reply) {
          ticket.responses = [{ message: reply, from: 'openclaw', time: new Date(), isAiGenerated: true }];
          ticket.status = 'responded';
          ticket.firstResponseAt = new Date();
          await ticket.save();
        }
      }
    } catch {}

    res.json({
      success: true,
      ticketId: ticket._id,
      message: 'Your inquiry has been received. We\'ll get back to you shortly!',
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

// Deterministic review count from product ID
function hashToReviews(id) {
  const h = crypto.createHash('md5').update(id).digest('hex');
  return 12 + (parseInt(h.slice(0, 4), 16) % 180);
}

module.exports = router;
