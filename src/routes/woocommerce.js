const express = require('express');
const router = express.Router();
const WooCommerceService = require('../services/WooCommerceService');

/**
 * WooCommerce API Routes
 * Base path: /api/woocommerce
 */

// Test connection status
router.get('/status', async (req, res) => {
    try {
          const status = await WooCommerceService.testConnection();
          res.json(status);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

// Products endpoints
router.get('/products', async (req, res) => {
    try {
          const products = await WooCommerceService.listProducts(req.query);
          res.json(products);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

router.get('/products/:id', async (req, res) => {
    try {
          const product = await WooCommerceService.getProduct(req.params.id);
          res.json(product);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

router.post('/products', async (req, res) => {
    try {
          const product = await WooCommerceService.createProduct(req.body);
          res.status(201).json(product);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

router.put('/products/:id', async (req, res) => {
    try {
          const product = await WooCommerceService.updateProduct(req.params.id, req.body);
          res.json(product);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

router.delete('/products/:id', async (req, res) => {
    try {
          const result = await WooCommerceService.deleteProduct(req.params.id);
          res.json(result);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

// Orders endpoints
router.get('/orders', async (req, res) => {
    try {
          const orders = await WooCommerceService.listOrders(req.query);
          res.json(orders);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

router.get('/orders/:id', async (req, res) => {
    try {
          const order = await WooCommerceService.getOrder(req.params.id);
          res.json(order);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

router.post('/orders', async (req, res) => {
    try {
          const order = await WooCommerceService.createOrder(req.body);
          res.status(201).json(order);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

// Customers endpoint
router.get('/customers', async (req, res) => {
    try {
          const customers = await WooCommerceService.listCustomers(req.query);
          res.json(customers);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

// Categories endpoint
router.get('/categories', async (req, res) => {
    try {
          const categories = await WooCommerceService.listCategories(req.query);
          res.json(categories);
    } catch (error) {
          res.status(500).json({ error: error.message });
    }
});

// Webhook endpoint for WooCommerce
router.post('/webhook', async (req, res) => {
      try {
              console.log('WooCommerce webhook received:', req.body);
              // Process the webhook payload
              const payload = req.body;

              // Handle different webhook topics
              if (payload.id) {
                        // This is a product webhook
                        console.log('Product webhook - ID:', payload.id, 'Name:', payload.name);
              }

              res.status(200).json({ received: true });
      } catch (error) {
              console.error('Webhook error:', error);
              res.status(500).json({ error: error.message });
      }
});



module.exports = router;
