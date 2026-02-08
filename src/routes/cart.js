const express = require('express');
const { Product } = require('../models');
const logger = require('../utils/logger');

const router = express.Router();

// In-memory cart storage (can be moved to Redis/MongoDB later)
const cartStorage = new Map();

/**
 * GET /api/cart/:sessionId - Get cart contents for session
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const cart = cartStorage.get(sessionId) || { items: [], total: 0 };
    
    // Populate product details
    const populatedItems = [];
    for (const item of cart.items) {
      const product = await Product.findById(item.productId).lean();
      if (product) {
        populatedItems.push({
          ...item,
          product: {
            _id: product._id,
            title: product.title,
            featuredImage: product.featuredImage,
            sellingPriceAud: product.sellingPriceAud || 0,
            shopifyHandle: product.shopifyHandle
          }
        });
      }
    }
    
    // Recalculate total
    const total = populatedItems.reduce((sum, item) => 
      sum + ((item.product.sellingPriceAud || 0) * item.quantity), 0
    );
    
    res.json({
      sessionId,
      items: populatedItems,
      total: total.toFixed(2),
      itemCount: populatedItems.reduce((sum, item) => sum + item.quantity, 0)
    });
    
    logger.info(`Cart retrieved for session ${sessionId}: ${populatedItems.length} items`);
  } catch (error) {
    logger.error('Cart retrieval error', { error: error.message });
    res.status(500).json({ error: 'Failed to retrieve cart' });
  }
});

/**
 * POST /api/cart/add - Add item to cart
 * Body: { sessionId, productId, quantity }
 */
router.post('/add', async (req, res) => {
  try {
    const { sessionId, productId, quantity = 1 } = req.body;
    
    if (!sessionId || !productId) {
      return res.status(400).json({ error: 'sessionId and productId are required' });
    }
    
    // Verify product exists
    const product = await Product.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Get or create cart
    const cart = cartStorage.get(sessionId) || { items: [], total: 0 };
    
    // Check if item already exists in cart
    const existingItemIndex = cart.items.findIndex(item => item.productId === productId);
    
    if (existingItemIndex >= 0) {
      // Update quantity
      cart.items[existingItemIndex].quantity += quantity;
      cart.items[existingItemIndex].updatedAt = new Date();
    } else {
      // Add new item
      cart.items.push({
        productId,
        quantity,
        addedAt: new Date(),
        updatedAt: new Date()
      });
    }
    
    // Save cart
    cartStorage.set(sessionId, cart);
    
    res.json({ 
      success: true, 
      message: `${product.title} added to cart`,
      cartItemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0)
    });
    
    logger.info(`Product added to cart: ${product.title} (session: ${sessionId})`);
  } catch (error) {
    logger.error('Cart add error', { error: error.message });
    res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

/**
 * PUT /api/cart/update - Update item quantity in cart
 * Body: { sessionId, productId, quantity }
 */
router.put('/update', async (req, res) => {
  try {
    const { sessionId, productId, quantity } = req.body;
    
    if (!sessionId || !productId || quantity < 0) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    }
    
    const cart = cartStorage.get(sessionId);
    if (!cart) {
      return res.status(404).json({ error: 'Cart not found' });
    }
    
    const itemIndex = cart.items.findIndex(item => item.productId === productId);
    if (itemIndex < 0) {
      return res.status(404).json({ error: 'Item not found in cart' });
    }
    
    if (quantity === 0) {
      // Remove item
      cart.items.splice(itemIndex, 1);
    } else {
      // Update quantity
      cart.items[itemIndex].quantity = quantity;
      cart.items[itemIndex].updatedAt = new Date();
    }
    
    cartStorage.set(sessionId, cart);
    
    res.json({ 
      success: true, 
      message: 'Cart updated',
      cartItemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0)
    });
    
    logger.info(`Cart updated for session ${sessionId}`);
  } catch (error) {
    logger.error('Cart update error', { error: error.message });
    res.status(500).json({ error: 'Failed to update cart' });
  }
});

/**
 * DELETE /api/cart/remove - Remove item from cart
 * Body: { sessionId, productId }
 */
router.delete('/remove', async (req, res) => {
  try {
    const { sessionId, productId } = req.body;
    
    if (!sessionId || !productId) {
      return res.status(400).json({ error: 'sessionId and productId are required' });
    }
    
    const cart = cartStorage.get(sessionId);
    if (!cart) {
      return res.status(404).json({ error: 'Cart not found' });
    }
    
    const initialLength = cart.items.length;
    cart.items = cart.items.filter(item => item.productId !== productId);
    
    if (cart.items.length === initialLength) {
      return res.status(404).json({ error: 'Item not found in cart' });
    }
    
    cartStorage.set(sessionId, cart);
    
    res.json({ 
      success: true, 
      message: 'Item removed from cart',
      cartItemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0)
    });
    
    logger.info(`Item removed from cart for session ${sessionId}`);
  } catch (error) {
    logger.error('Cart remove error', { error: error.message });
    res.status(500).json({ error: 'Failed to remove item from cart' });
  }
});

/**
 * DELETE /api/cart/clear/:sessionId - Clear entire cart
 */
router.delete('/clear/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    cartStorage.delete(sessionId);
    
    res.json({ 
      success: true, 
      message: 'Cart cleared',
      cartItemCount: 0
    });
    
    logger.info(`Cart cleared for session ${sessionId}`);
  } catch (error) {
    logger.error('Cart clear error', { error: error.message });
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

/**
 * GET /api/cart/stats - Get cart statistics (admin)
 */
router.get('/admin/stats', async (req, res) => {
  try {
    const stats = {
      totalActiveCarts: cartStorage.size,
      totalItems: 0,
      totalValue: 0,
      carts: []
    };
    
    for (const [sessionId, cart] of cartStorage.entries()) {
      const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      stats.totalItems += itemCount;
      
      // Calculate cart value
      let cartValue = 0;
      for (const item of cart.items) {
        const product = await Product.findById(item.productId).lean();
        if (product) {
          cartValue += (product.sellingPriceAud || 0) * item.quantity;
        }
      }
      stats.totalValue += cartValue;
      
      stats.carts.push({
        sessionId,
        itemCount,
        value: cartValue.toFixed(2),
        lastUpdated: cart.items.reduce((latest, item) => 
          item.updatedAt > latest ? item.updatedAt : latest, 
          new Date(0)
        )
      });
    }
    
    res.json(stats);
  } catch (error) {
    logger.error('Cart stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get cart statistics' });
  }
});

module.exports = router;