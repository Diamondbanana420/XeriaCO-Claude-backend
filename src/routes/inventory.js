const express = require('express');
const { Product } = require('../models');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/inventory - Get inventory status for all products
 */
router.get('/', async (req, res) => {
  try {
    const products = await Product.find({}, {
      _id: 1,
      title: 1,
      stockQuantity: 1,
      stockStatus: 1,
      supplierPrice: 1,
      sellingPriceAud: 1,
      shopifyStatus: 1,
      updatedAt: 1
    }).sort({ updatedAt: -1 });

    const inventory = products.map(product => ({
      ...product.toObject(),
      profitMargin: product.sellingPriceAud && product.supplierPrice 
        ? (((product.sellingPriceAud - product.supplierPrice) / product.sellingPriceAud) * 100).toFixed(1)
        : null,
      stockStatus: getStockStatus(product.stockQuantity),
      needsRestock: product.stockQuantity < 10
    }));

    const stats = {
      total: inventory.length,
      inStock: inventory.filter(p => p.stockQuantity > 0).length,
      lowStock: inventory.filter(p => p.stockQuantity > 0 && p.stockQuantity < 10).length,
      outOfStock: inventory.filter(p => p.stockQuantity === 0).length,
      totalValue: inventory.reduce((sum, p) => sum + ((p.sellingPriceAud || 0) * (p.stockQuantity || 0)), 0)
    };

    res.json({
      inventory,
      stats
    });

    logger.info(`Inventory retrieved: ${inventory.length} products`);
  } catch (error) {
    logger.error('Inventory retrieval error', { error: error.message });
    res.status(500).json({ error: 'Failed to retrieve inventory' });
  }
});

/**
 * PUT /api/inventory/:productId/stock - Update product stock
 * Body: { quantity, operation: 'set'|'add'|'subtract' }
 */
router.put('/:productId/stock', async (req, res) => {
  try {
    const { productId } = req.params;
    const { quantity, operation = 'set', reason } = req.body;

    if (typeof quantity !== 'number' || quantity < 0) {
      return res.status(400).json({ error: 'Valid quantity required' });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const oldQuantity = product.stockQuantity || 0;
    let newQuantity;

    switch (operation) {
      case 'add':
        newQuantity = oldQuantity + quantity;
        break;
      case 'subtract':
        newQuantity = Math.max(0, oldQuantity - quantity);
        break;
      case 'set':
      default:
        newQuantity = quantity;
        break;
    }

    product.stockQuantity = newQuantity;
    product.stockStatus = getStockStatus(newQuantity);
    product.updatedAt = new Date();

    // Add inventory log entry
    if (!product.inventoryLog) {
      product.inventoryLog = [];
    }
    
    product.inventoryLog.push({
      date: new Date(),
      operation,
      oldQuantity,
      newQuantity,
      quantity: operation === 'set' ? quantity : (operation === 'add' ? quantity : -quantity),
      reason: reason || `Stock ${operation}`,
      updatedBy: 'system'
    });

    // Keep only last 50 log entries
    if (product.inventoryLog.length > 50) {
      product.inventoryLog = product.inventoryLog.slice(-50);
    }

    await product.save();

    res.json({
      success: true,
      productId,
      oldQuantity,
      newQuantity,
      stockStatus: product.stockStatus,
      message: `Stock ${operation}: ${oldQuantity} → ${newQuantity}`
    });

    logger.info(`Stock updated: ${product.title} (${oldQuantity} → ${newQuantity})`);
  } catch (error) {
    logger.error('Stock update error', { error: error.message });
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

/**
 * GET /api/inventory/:productId/history - Get inventory history for product
 */
router.get('/:productId/history', async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await Product.findById(productId, { inventoryLog: 1, title: 1 });
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      productId,
      title: product.title,
      history: product.inventoryLog || []
    });
  } catch (error) {
    logger.error('Inventory history error', { error: error.message });
    res.status(500).json({ error: 'Failed to retrieve inventory history' });
  }
});

/**
 * GET /api/inventory/alerts - Get inventory alerts (low stock, etc.)
 */
router.get('/alerts', async (req, res) => {
  try {
    const lowStockThreshold = parseInt(req.query.threshold) || 10;
    
    const lowStockProducts = await Product.find({
      stockQuantity: { $lte: lowStockThreshold, $gt: 0 }
    }, { title: 1, stockQuantity: 1, sellingPriceAud: 1 });

    const outOfStockProducts = await Product.find({
      $or: [{ stockQuantity: 0 }, { stockQuantity: { $exists: false } }]
    }, { title: 1, stockQuantity: 1, sellingPriceAud: 1 });

    const alerts = {
      lowStock: lowStockProducts.map(p => ({
        productId: p._id,
        title: p.title,
        currentStock: p.stockQuantity,
        suggestedReorder: Math.max(50, lowStockThreshold * 5),
        priority: p.stockQuantity <= 3 ? 'high' : 'medium'
      })),
      outOfStock: outOfStockProducts.map(p => ({
        productId: p._id,
        title: p.title,
        currentStock: p.stockQuantity || 0,
        priority: 'high'
      }))
    };

    const summary = {
      totalAlerts: alerts.lowStock.length + alerts.outOfStock.length,
      highPriority: alerts.lowStock.filter(p => p.priority === 'high').length + alerts.outOfStock.length,
      potentialLostRevenue: [
        ...alerts.lowStock,
        ...alerts.outOfStock
      ].reduce((sum, p) => sum + ((p.sellingPriceAud || 0) * 20), 0) // Estimate 20 lost sales per out-of-stock item
    };

    res.json({ alerts, summary });
  } catch (error) {
    logger.error('Inventory alerts error', { error: error.message });
    res.status(500).json({ error: 'Failed to retrieve inventory alerts' });
  }
});

/**
 * POST /api/inventory/bulk-update - Bulk update inventory
 * Body: { updates: [{ productId, quantity, operation }] }
 */
router.post('/bulk-update', async (req, res) => {
  try {
    const { updates } = req.body;
    
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array required' });
    }

    const results = [];
    const errors = [];

    for (const update of updates) {
      try {
        const { productId, quantity, operation = 'set' } = update;
        const product = await Product.findById(productId);
        
        if (!product) {
          errors.push({ productId, error: 'Product not found' });
          continue;
        }

        const oldQuantity = product.stockQuantity || 0;
        let newQuantity;

        switch (operation) {
          case 'add':
            newQuantity = oldQuantity + quantity;
            break;
          case 'subtract':
            newQuantity = Math.max(0, oldQuantity - quantity);
            break;
          case 'set':
          default:
            newQuantity = quantity;
            break;
        }

        product.stockQuantity = newQuantity;
        product.stockStatus = getStockStatus(newQuantity);
        await product.save();

        results.push({
          productId,
          title: product.title,
          oldQuantity,
          newQuantity,
          operation
        });
      } catch (err) {
        errors.push({ productId: update.productId, error: err.message });
      }
    }

    res.json({
      success: true,
      processed: results.length,
      errors: errors.length,
      results,
      errors
    });

    logger.info(`Bulk inventory update: ${results.length} products updated, ${errors.length} errors`);
  } catch (error) {
    logger.error('Bulk inventory update error', { error: error.message });
    res.status(500).json({ error: 'Failed to bulk update inventory' });
  }
});

/**
 * Helper function to determine stock status
 */
function getStockStatus(quantity) {
  if (!quantity || quantity === 0) return 'out_of_stock';
  if (quantity <= 5) return 'low_stock';
  if (quantity <= 20) return 'medium_stock';
  return 'in_stock';
}

module.exports = router;