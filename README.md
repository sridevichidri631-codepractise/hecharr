# 🍬 Hecharr — Full Stack Gummy Ecommerce

A complete DTC gummy brand ecommerce platform built with:
- **Frontend**: HTML/CSS/JS → deploy to **Netlify**
- **Backend**: Node.js + Express → deploy to **Railway**
- **Database**: PostgreSQL → hosted on **Supabase**
- **Payments**: **Stripe** Checkout + Subscriptions

---

## 📁 Project Structure

```
hecharr/
├── storefront/       ← Customer-facing store (Netlify)
│   └── index.html
├── admin/            ← Admin dashboard (Netlify)
│   └── index.html
├── backend/          ← API server (Railway)
│   ├── server.js
│   ├── package.json
│   └── .env.example
└── database/         ← SQL schema (Supabase)
    └── schema.sql
```

---

## 🚀 Deployment Guide

### Step 1 — Set Up Supabase

1. Go to [supabase.com](https://supabase.com) → Create new project
2. Choose a region close to your users
3. Go to **SQL Editor** and paste the contents of `database/schema.sql`
4. Click **Run** — this creates all tables, RLS policies, and seed data
5. Go to **Project Settings → API** and copy:
   - `Project URL`
   - `anon public` key
   - `service_role` key (keep this secret!)

### Step 2 — Set Up Stripe

1. Go to [dashboard.stripe.com](https://dashboard.stripe.com)
2. Copy your **Secret Key** and **Publishable Key** from Developers → API Keys
3. After deploying backend, add a Webhook endpoint:
   - URL: `https://your-api.railway.app/webhooks/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_*`
4. Copy the **Webhook Signing Secret**

### Step 3 — Deploy Backend to Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Connect your GitHub repo (push the `backend/` folder)
3. Railway auto-detects Node.js and runs `npm start`
4. Go to **Variables** and add all env vars from `.env.example`:
   ```
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...
   STRIPE_SECRET_KEY=...
   STRIPE_WEBHOOK_SECRET=...
   FRONTEND_URL=https://hecharr.netlify.app
   ```
5. Go to **Settings → Networking** → Generate Domain
6. Note your Railway URL (e.g. `https://hecharr-api.railway.app`)

### Step 4 — Deploy Frontend to Netlify

1. Go to [netlify.com](https://netlify.com) → New site → Deploy manually
2. Drag and drop the `storefront/` folder
3. Your store will be live instantly!
4. Add custom domain in **Domain Management** (optional)

**Connect frontend to backend:**
Update the API base URL in `storefront/index.html`:
```javascript
const API_URL = 'https://your-api.railway.app';
```

### Step 5 — Set Yourself as Admin

Run this in Supabase SQL Editor (replace with your user ID after signing up):
```sql
UPDATE profiles SET is_admin = TRUE WHERE email = 'your@email.com';
```

---

## 🔑 API Reference

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/products` | List all products |
| GET | `/api/products/:slug` | Single product with reviews |
| POST | `/api/checkout` | Create Stripe checkout session |
| POST | `/api/coupons/validate` | Validate a coupon code |
| POST | `/api/reviews` | Submit a review (pending approval) |

### Authenticated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profile` | Get user profile |
| PATCH | `/api/profile` | Update profile |
| GET | `/api/orders` | User's order history |
| GET | `/api/subscriptions` | User's subscriptions |
| POST | `/api/subscriptions/:id/pause` | Pause subscription |
| POST | `/api/subscriptions/:id/cancel` | Cancel subscription |

### Admin Endpoints (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/stats` | Dashboard stats |
| GET | `/api/admin/orders` | All orders (paginated) |
| PATCH | `/api/admin/orders/:id` | Update order status |
| GET | `/api/admin/products` | All products |
| POST | `/api/admin/products` | Create product |
| PATCH | `/api/admin/reviews/:id` | Approve/reject review |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/stripe` | Stripe event handler |

---

## 🍬 Features

### Customer Storefront
- ✅ Homepage with hero, benefits, product grid
- ✅ Product filtering by category
- ✅ Cart drawer with quantity management
- ✅ Subscribe & Save toggle (15% discount)
- ✅ Customer reviews display
- ✅ Responsive mobile design
- ✅ Stripe Checkout integration

### Admin Dashboard
- ✅ Revenue & order metrics
- ✅ Revenue bar chart (last 7 days)
- ✅ Sales by category donut chart
- ✅ Order management with status updates
- ✅ Product management + add new products
- ✅ Review approval queue
- ✅ Subscription management
- ✅ Coupon creation & management
- ✅ Customer database

### Backend API
- ✅ Supabase Row Level Security on all tables
- ✅ Stripe Checkout (one-time + subscription)
- ✅ Stripe Webhook handling
- ✅ Order creation from webhook events
- ✅ Stock management
- ✅ Coupon validation
- ✅ Admin-only routes
- ✅ JWT auth via Supabase

### Database
- ✅ profiles, categories, products, product_variants
- ✅ orders, order_items (with price snapshots)
- ✅ subscriptions
- ✅ reviews (with approval workflow)
- ✅ coupons
- ✅ analytics_events
- ✅ Row Level Security policies on all tables
- ✅ Seed data included

---

## 🔐 Security Notes

- Never expose `SUPABASE_SERVICE_ROLE_KEY` to the frontend
- All admin routes are protected by `requireAdmin` middleware
- Row Level Security enforced at the database level
- Stripe webhook signature verified on every request
- Prices stored in cents (integers) to avoid floating point issues

---

## 📦 Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, CSS, Vanilla JS |
| Backend | Node.js, Express |
| Database | PostgreSQL (via Supabase) |
| Auth | Supabase Auth (JWT) |
| Payments | Stripe Checkout + Billing |
| Hosting (Frontend) | Netlify |
| Hosting (Backend) | Railway |
| Storage | Supabase Storage (for product images) |
