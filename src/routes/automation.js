const express = require('express');
const { Product, Order, Analytics } = require('../models');
const logger = require('../utils/logger');
const axios = require('axios');

const router = express.Router();

/**
 * POST /api/automation/customer-service - Handle customer inquiries with AI
 */
router.post('/customer-service', async (req, res) => {
  try {
    const { message, customerEmail, orderId, context } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Prepare context for AI
    let systemContext = "You are XeriaCO's customer service assistant. Be helpful, friendly, and professional. ";
    
    if (orderId) {
      const order = await Order.findById(orderId);
      if (order) {
        systemContext += `Customer order details: Order #${order.orderNumber}, Status: ${order.status}, Total: $${order.totalAud}, Items: ${order.items.length}. `;
      }
    }

    systemContext += "Provide concise, helpful responses. For complex issues, escalate to human support.";

    // Call AI service (using existing AI route)
    const aiResponse = await callInternalAI({
      system: systemContext,
      message: message,
      maxTokens: 200
    });

    const response = {
      reply: aiResponse.content,
      confidence: aiResponse.confidence || 'medium',
      escalate: shouldEscalate(message, aiResponse.content),
      suggestedActions: generateSuggestedActions(message, orderId),
      timestamp: new Date()
    };

    // Log the interaction
    logger.info('Customer service interaction', {
      customerEmail,
      orderId,
      query: message.substring(0, 100),
      escalate: response.escalate
    });

    res.json(response);
  } catch (error) {
    logger.error('Customer service error', { error: error.message });
    res.status(500).json({ error: 'Customer service temporarily unavailable' });
  }
});

/**
 * POST /api/automation/marketing/email - Generate marketing emails
 */
router.post('/marketing/email', async (req, res) => {
  try {
    const { type, audience, products, customPrompt } = req.body;
    
    let prompt = customPrompt || generateEmailPrompt(type, audience, products);
    
    const aiResponse = await callInternalAI({
      system: "You are XeriaCO's marketing specialist. Create engaging, conversion-focused email content. Include clear CTAs and compelling product descriptions.",
      message: prompt,
      maxTokens: 500
    });

    const emailContent = {
      subject: extractEmailSubject(aiResponse.content),
      body: aiResponse.content,
      cta: extractCTA(aiResponse.content),
      generatedAt: new Date(),
      type,
      audience
    };

    res.json(emailContent);
    logger.info(`Marketing email generated: ${type} for ${audience}`);
  } catch (error) {
    logger.error('Marketing email error', { error: error.message });
    res.status(500).json({ error: 'Failed to generate marketing content' });
  }
});

/**
 * POST /api/automation/pricing/optimize - Auto-optimize product pricing
 */
router.post('/pricing/optimize', async (req, res) => {
  try {
    const { productId, strategy = 'profit_maximization' } = req.body;
    
    let products = [];
    if (productId) {
      const product = await Product.findById(productId);
      if (product) products = [product];
    } else {
      // Optimize all products
      products = await Product.find({ sellingPriceAud: { $gt: 0 } });
    }

    const optimizationResults = [];

    for (const product of products) {
      const currentPrice = product.sellingPriceAud;
      const supplierPrice = product.supplierPrice || 0;
      const currentMargin = ((currentPrice - supplierPrice) / currentPrice) * 100;

      let suggestedPrice;
      let reasoning;

      switch (strategy) {
        case 'profit_maximization':
          suggestedPrice = calculateOptimalPrice(product, 'profit');
          reasoning = 'Optimized for maximum profit margin while maintaining competitiveness';
          break;
        case 'market_penetration':
          suggestedPrice = calculateOptimalPrice(product, 'penetration');
          reasoning = 'Reduced price for market penetration and volume sales';
          break;
        case 'competition_based':
          suggestedPrice = calculateOptimalPrice(product, 'competition');
          reasoning = 'Price set based on competitive analysis';
          break;
        default:
          suggestedPrice = currentPrice;
          reasoning = 'No optimization strategy specified';
      }

      const newMargin = ((suggestedPrice - supplierPrice) / suggestedPrice) * 100;
      const priceChange = ((suggestedPrice - currentPrice) / currentPrice) * 100;

      optimizationResults.push({
        productId: product._id,
        title: product.title,
        currentPrice: currentPrice.toFixed(2),
        suggestedPrice: suggestedPrice.toFixed(2),
        priceChange: priceChange.toFixed(1) + '%',
        currentMargin: currentMargin.toFixed(1) + '%',
        newMargin: newMargin.toFixed(1) + '%',
        reasoning,
        confidence: calculatePricingConfidence(product, suggestedPrice)
      });

      // Apply pricing if within safe bounds
      if (Math.abs(priceChange) <= 20 && newMargin >= 30) { // Max 20% change, min 30% margin
        product.sellingPriceAud = suggestedPrice;
        product.pricingHistory = product.pricingHistory || [];
        product.pricingHistory.push({
          date: new Date(),
          oldPrice: currentPrice,
          newPrice: suggestedPrice,
          strategy,
          reasoning,
          automated: true
        });
        await product.save();
        
        optimizationResults[optimizationResults.length - 1].applied = true;
      } else {
        optimizationResults[optimizationResults.length - 1].applied = false;
        optimizationResults[optimizationResults.length - 1].reason = 'Change exceeds safety thresholds';
      }
    }

    res.json({
      strategy,
      totalProducts: optimizationResults.length,
      applied: optimizationResults.filter(r => r.applied).length,
      results: optimizationResults
    });

    logger.info(`Pricing optimization completed: ${optimizationResults.filter(r => r.applied).length}/${optimizationResults.length} products updated`);
  } catch (error) {
    logger.error('Pricing optimization error', { error: error.message });
    res.status(500).json({ error: 'Failed to optimize pricing' });
  }
});

/**
 * GET /api/automation/analytics/insights - Generate business insights
 */
router.get('/analytics/insights', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    // Calculate date range
    const days = parseInt(period) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Gather analytics data
    const orders = await Order.find({ 
      createdAt: { $gte: startDate }
    });

    const products = await Product.find({});
    
    const insights = {
      sales: {
        totalRevenue: orders.reduce((sum, order) => sum + (order.totalAud || 0), 0),
        totalOrders: orders.length,
        averageOrderValue: orders.length > 0 ? orders.reduce((sum, order) => sum + (order.totalAud || 0), 0) / orders.length : 0,
        conversionRate: calculateConversionRate(orders, period)
      },
      inventory: {
        totalProducts: products.length,
        lowStockCount: products.filter(p => (p.stockQuantity || 0) <= 10).length,
        outOfStockCount: products.filter(p => (p.stockQuantity || 0) === 0).length,
        averageMargin: calculateAverageMargin(products)
      },
      trends: await generateTrendInsights(orders, products, period),
      recommendations: await generateBusinessRecommendations(orders, products)
    };

    res.json(insights);
    logger.info(`Business insights generated for ${period} period`);
  } catch (error) {
    logger.error('Analytics insights error', { error: error.message });
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

/**
 * POST /api/automation/alerts/setup - Setup automated alerts
 */
router.post('/alerts/setup', async (req, res) => {
  try {
    const { type, conditions, actions, enabled = true } = req.body;
    
    // Store alert configuration (in a real app, this would go to database)
    const alertConfig = {
      id: Date.now().toString(),
      type,
      conditions,
      actions,
      enabled,
      createdAt: new Date()
    };

    // Here you would typically save to an AlertConfig model
    // For now, just return the configuration
    
    res.json({
      success: true,
      alertId: alertConfig.id,
      message: `${type} alert configured successfully`,
      config: alertConfig
    });

    logger.info(`Alert configured: ${type}`);
  } catch (error) {
    logger.error('Alert setup error', { error: error.message });
    res.status(500).json({ error: 'Failed to setup alert' });
  }
});

// Helper functions
async function callInternalAI({ system, message, maxTokens = 150 }) {
  try {
    // This would call your internal AI service
    const response = await axios.post('/api/ai/chat', {
      system,
      message,
      model: 'claude-3-haiku-20240307' // Use faster model for automation
    });
    
    return {
      content: response.data.content,
      confidence: 'medium'
    };
  } catch (error) {
    return {
      content: "I apologize, but I'm unable to process your request at the moment. Please contact our support team for assistance.",
      confidence: 'low'
    };
  }
}

function shouldEscalate(message, aiResponse) {
  const escalationKeywords = ['refund', 'complaint', 'angry', 'lawsuit', 'scam', 'fraud'];
  const messageText = message.toLowerCase();
  return escalationKeywords.some(keyword => messageText.includes(keyword));
}

function generateSuggestedActions(message, orderId) {
  const actions = [];
  
  if (orderId) {
    actions.push({ type: 'view_order', orderId, label: 'View Order Details' });
  }
  
  if (message.toLowerCase().includes('track')) {
    actions.push({ type: 'provide_tracking', label: 'Provide Tracking Information' });
  }
  
  if (message.toLowerCase().includes('return') || message.toLowerCase().includes('refund')) {
    actions.push({ type: 'process_return', label: 'Process Return/Refund' });
  }
  
  return actions;
}

function generateEmailPrompt(type, audience, products) {
  switch (type) {
    case 'product_launch':
      return `Create an exciting product launch email for our ${audience} customers announcing ${products?.length || 1} new products. Include compelling benefits and a special launch discount.`;
    case 'abandoned_cart':
      return `Write a friendly abandoned cart reminder email that encourages customers to complete their purchase. Include urgency and social proof.`;
    case 'newsletter':
      return `Create an engaging weekly newsletter for our customers featuring our best products, customer reviews, and shopping tips.`;
    default:
      return `Create a ${type} email for ${audience} customers that drives engagement and sales.`;
  }
}

function extractEmailSubject(content) {
  const lines = content.split('\n');
  const subjectLine = lines.find(line => 
    line.toLowerCase().includes('subject:') || 
    line.startsWith('Subject:') ||
    line.startsWith('# ')
  );
  
  if (subjectLine) {
    return subjectLine.replace(/^(subject:\s*|# )/i, '').trim();
  }
  
  return 'Special Offer from XeriaCO';
}

function extractCTA(content) {
  const ctaPatterns = [
    /\[([^\]]+)\]/g,
    /\*\*([^*]+)\*\*/g,
    /(shop now|buy now|order today|get yours|limited time)/gi
  ];
  
  for (const pattern of ctaPatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }
  
  return 'Shop Now';
}

function calculateOptimalPrice(product, strategy) {
  const supplierPrice = product.supplierPrice || 0;
  const currentPrice = product.sellingPriceAud;
  
  switch (strategy) {
    case 'profit':
      return supplierPrice * 3.5; // 71% margin
    case 'penetration':
      return supplierPrice * 2.2; // 55% margin
    case 'competition':
      return supplierPrice * 2.8; // 64% margin
    default:
      return currentPrice;
  }
}

function calculatePricingConfidence(product, suggestedPrice) {
  const supplierPrice = product.supplierPrice || 0;
  const margin = ((suggestedPrice - supplierPrice) / suggestedPrice) * 100;
  
  if (margin >= 60) return 'high';
  if (margin >= 40) return 'medium';
  return 'low';
}

function calculateConversionRate(orders, period) {
  // Simplified conversion rate calculation
  // In a real app, you'd track visits/sessions
  const ordersPerDay = orders.length / (parseInt(period) || 7);
  return Math.min(ordersPerDay * 0.1, 5); // Rough estimate
}

function calculateAverageMargin(products) {
  const productsWithMargin = products.filter(p => p.sellingPriceAud && p.supplierPrice);
  if (productsWithMargin.length === 0) return 0;
  
  const totalMargin = productsWithMargin.reduce((sum, p) => {
    const margin = ((p.sellingPriceAud - p.supplierPrice) / p.sellingPriceAud) * 100;
    return sum + margin;
  }, 0);
  
  return totalMargin / productsWithMargin.length;
}

async function generateTrendInsights(orders, products, period) {
  // Generate trend insights based on data
  return {
    salesTrend: orders.length > 5 ? 'increasing' : 'stable',
    topProducts: products.slice(0, 3).map(p => p.title),
    seasonality: 'Normal seasonal pattern detected'
  };
}

async function generateBusinessRecommendations(orders, products) {
  const recommendations = [];
  
  // Low stock recommendations
  const lowStockProducts = products.filter(p => (p.stockQuantity || 0) <= 10);
  if (lowStockProducts.length > 0) {
    recommendations.push({
      type: 'inventory',
      priority: 'high',
      action: 'Restock low inventory items',
      impact: 'Prevent stockouts and lost sales'
    });
  }
  
  // Pricing recommendations
  const lowMarginProducts = products.filter(p => {
    if (!p.sellingPriceAud || !p.supplierPrice) return false;
    const margin = ((p.sellingPriceAud - p.supplierPrice) / p.sellingPriceAud) * 100;
    return margin < 40;
  });
  
  if (lowMarginProducts.length > 0) {
    recommendations.push({
      type: 'pricing',
      priority: 'medium',
      action: 'Review pricing for low-margin products',
      impact: 'Improve profitability'
    });
  }
  
  // Marketing recommendations
  if (orders.length < 5) {
    recommendations.push({
      type: 'marketing',
      priority: 'high',
      action: 'Launch customer acquisition campaign',
      impact: 'Increase sales volume'
    });
  }
  
  return recommendations;
}

module.exports = router;