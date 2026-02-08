# XeriaCO-Claude-Backend

Combined Backend + V9 Frontend — AI-Powered E-Commerce Platform

## Architecture
```
Backend (Express + MongoDB)
├── /api/store/*        — Public storefront (products, orders, support)
├── /api/openclaw/*     — AI management system (natural language commands)
├── /api/pipeline/*     — Product discovery & enrichment pipeline
├── /api/admin/*        — Admin dashboard API
├── /api/orders/*       — Order management
├── /api/products/*     — Product CRUD
├── /api/analytics/*    — Sales analytics
├── /api/marketplace/*  — Multi-channel sync (Shopify, WooCommerce, Amazon, eBay)
├── /api/ai/*           — AI provider proxy
├── /api/webhooks/*     — Auto-list webhook, pipeline triggers
└── /* (catch-all)      — Serves V9 React frontend
```

## V9 Frontend
The React frontend is pre-built and served from `public/` directory.
Source code: `frontend/V9.jsx` (2,132 lines)

### Features
- **Dashboard** — Real-time metrics, product stats, order tracking
- **Storefront** — Customer-facing shop with cart, checkout, order tracking, support
- **Pipeline** — AI product discovery, trend scouting, supplier sourcing
- **OpenClaw** — Natural language AI management (chat, support, product editing)
- **Discovery** — Auto-discovery with scoring, approval, bulk actions
- **Settings** — API keys, store config, marketplace connections

## Key Integrations
- **MongoDB** — All data storage (products, orders, tickets, pipeline runs)
- **Auto-List Webhook** — `POST /api/webhooks/auto-list` marks products as listed
- **Pipeline → Storefront** — Discovered products auto-listed after pipeline completion
- **Discord** — Order and pipeline notifications
- **AI** — Anthropic Claude for OpenClaw commands, support auto-reply, product editing

## Environment Variables
```
MONGODB_URI=mongodb+srv://...
ADMIN_PASSWORD=xeriaco2026
ANTHROPIC_API_KEY=sk-ant-...
DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
PORT=3000
NODE_ENV=production
```

## Deploy to Railway
1. Connect this repo in Railway dashboard
2. Set environment variables (especially MONGODB_URI)
3. Railway auto-detects Node.js, runs `npm start`
4. Frontend served at root, API at /api/*

## Current Status
- **Backend**: ✅ Live on Railway
- **Frontend**: ✅ Served from backend (local files, CDN fallback)  
- **MongoDB**: ✅ Connected
- **Store API**: ✅ 4 products, orders, tracking, support
- **OpenClaw**: ✅ 30+ actions, quick commands
- **Pipeline**: ✅ Auto-list on completion
- **AI Chat**: ⚠️ Needs valid ANTHROPIC_API_KEY for full features
