const express = require('express');
const config = require('../../config');
const logger = require('../utils/logger');

const router = express.Router();

let stripe;
if (config.stripe?.secretKey) {
  stripe = require('stripe')(config.stripe.secretKey);
}

router.post('/create-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured' });
    }

    const { items, sessionId } = req.body;
    
    // If sessionId provided, get items from cart
    let checkoutItems = items;
    if (sessionId && !items) {
      // Import cart storage from cart routes
      const cartModule = require('./cart');
      const cartData = await fetch(`${req.protocol}://${req.get('host')}/api/cart/${sessionId}`);
      if (cartData.ok) {
        const cart = await cartData.json();
        checkoutItems = cart.items.map(item => ({
          productId: item.productId,
          quantity: item.quantity
        }));
      }
    }
    
    if (!checkoutItems || !checkoutItems.length) {
      return res.status(400).json({ error: 'No items provided' });
    }

    const { Product } = require('../models');
    const lineItems = [];

    for (const item of items) {
      const product = await Product.findById(item.productId).lean();
      if (!product) {
        logger.warn(`Checkout: Product not found — ${item.productId}`);
        continue;
      }

      lineItems.push({
        price_data: {
          currency: 'aud',
          product_data: {
            name: product.title,
            images: product.featuredImage ? [product.featuredImage] : [],
          },
          unit_amount: Math.round((product.sellingPriceAud || 0) * 100),
        },
        quantity: item.quantity || 1,
      });
    }

    if (!lineItems.length) {
      return res.status(400).json({ error: 'No valid products found' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://xeriaco-frontend-production.up.railway.app';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${frontendUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/cart`,
    });

    logger.info(`Checkout: Session created — ${session.id}`);
    res.json({ url: session.url });
  } catch (err) {
    logger.error('Checkout error', { error: err.message });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!stripe || !config.stripe?.webhookSecret) {
      return res.status(400).json({ error: 'Webhook not configured' });
    }

    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      logger.info(`Checkout: Payment completed — session ${session.id}, amount ${session.amount_total}`);
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook error', { error: err.message });
    res.status(400).json({ error: 'Webhook verification failed' });
  }
});

module.exports = router;
