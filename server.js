// ================================================================
// Hecharr Backend API — Node.js + Express + Stripe + Supabase
// Deploy to Railway: https://railway.app
// ================================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Clients ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ── Stripe webhook needs raw body — BEFORE express.json() ────────
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

// ── Middleware ───────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// ── Request logger ───────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();

  if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

  req.user = user;
  req.profile = profile;
  next();
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hecharr-api', ts: new Date().toISOString() });
});

// ================================================================
// PRODUCTS
// ================================================================

// GET /api/products — list all active products
app.get('/api/products', async (req, res) => {
  try {
    const { featured, category_slug } = req.query;

    let query = supabase
      .from('products')
      .select(`
        id, name, slug, tagline, description, benefits,
        image_url, badge, is_featured,
        category:categories(name, slug),
        variants:product_variants(
          id, name, sku, price_cents, compare_at_price_cents,
          subscription_price_cents, stock_quantity
        )
      `)
      .eq('is_active', true)
      .order('sort_order');

    if (featured === 'true') query = query.eq('is_featured', true);

    const { data, error } = await query;
    if (error) throw error;

    // Filter by category if requested
    let products = data;
    if (category_slug) {
      products = data.filter(p => p.category?.slug === category_slug);
    }

    res.json({ data: products, count: products.length });
  } catch (err) {
    console.error('GET /api/products error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:slug — single product with reviews
app.get('/api/products/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        category:categories(name, slug),
        variants:product_variants(*),
        reviews(id, author_name, rating, title, body, is_verified_purchase, created_at)
      `)
      .eq('slug', req.params.slug)
      .eq('is_active', true)
      .eq('reviews.is_approved', true)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Product not found' });

    // Compute avg rating
    const reviews = data.reviews || [];
    const avgRating = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : 0;

    res.json({ data: { ...data, avg_rating: avgRating, review_count: reviews.length } });
  } catch (err) {
    console.error('GET /api/products/:slug error:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// ================================================================
// CHECKOUT — Create Stripe Checkout Session
// ================================================================
app.post('/api/checkout', async (req, res) => {
  try {
    const {
      items,          // [{ variant_id, quantity, is_subscription }]
      coupon_code,
      customer_email,
      success_url,
      cancel_url
    } = req.body;

    if (!items?.length) return res.status(400).json({ error: 'No items provided' });

    // Validate variants exist
    const variantIds = items.map(i => i.variant_id);
    const { data: variants, error: varErr } = await supabase
      .from('product_variants')
      .select('id, name, price_cents, subscription_price_cents, stripe_price_id, stripe_subscription_price_id, stock_quantity, product:products(name, image_url)')
      .in('id', variantIds)
      .eq('is_active', true);

    if (varErr) throw varErr;
    if (variants.length !== items.length) {
      return res.status(400).json({ error: 'One or more invalid products' });
    }

    // Check stock
    for (const item of items) {
      const variant = variants.find(v => v.id === item.variant_id);
      if (variant.stock_quantity < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${variant.product.name}` });
      }
    }

    const hasSubscription = items.some(i => i.is_subscription);

    // Build Stripe line items
    const lineItems = items.map(item => {
      const variant = variants.find(v => v.id === item.variant_id);
      const isSubItem = item.is_subscription;

      // Use Stripe price IDs if they exist, otherwise create from price
      if (isSubItem && variant.stripe_subscription_price_id) {
        return { price: variant.stripe_subscription_price_id, quantity: item.quantity };
      } else if (!isSubItem && variant.stripe_price_id) {
        return { price: variant.stripe_price_id, quantity: item.quantity };
      } else {
        // Dynamic price data
        return {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${variant.product.name} — ${variant.name}`,
              images: variant.product.image_url ? [variant.product.image_url] : [],
            },
            unit_amount: isSubItem
              ? (variant.subscription_price_cents || Math.round(variant.price_cents * 0.85))
              : variant.price_cents,
            ...(isSubItem && { recurring: { interval: 'month' } }),
          },
          quantity: item.quantity,
        };
      }
    });

    // Validate coupon
    let discounts = [];
    if (coupon_code) {
      const { data: coupon } = await supabase
        .from('coupons')
        .select('*')
        .eq('code', coupon_code.toUpperCase())
        .eq('is_active', true)
        .single();

      if (coupon && coupon.stripe_coupon_id) {
        discounts = [{ coupon: coupon.stripe_coupon_id }];
        // Increment usage count
        await supabase
          .from('coupons')
          .update({ used_count: coupon.used_count + 1 })
          .eq('id', coupon.id);
      }
    }

    // Create Stripe session
    const session = await stripe.checkout.sessions.create({
      mode: hasSubscription ? 'subscription' : 'payment',
      line_items: lineItems,
      ...(discounts.length && { discounts }),
      ...(customer_email && { customer_email }),
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB'] },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'usd' },
            display_name: 'Free Shipping (5-7 business days)',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 999, currency: 'usd' },
            display_name: 'Priority Shipping (2-3 business days)',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 3 },
            },
          },
        },
      ],
      metadata: {
        items: JSON.stringify(items),
        coupon_code: coupon_code || '',
        source: 'hecharr-storefront',
      },
      success_url: success_url || `${process.env.FRONTEND_URL}/success?session={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${process.env.FRONTEND_URL}/#products`,
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('POST /api/checkout error:', err);
    res.status(500).json({ error: 'Checkout creation failed', details: err.message });
  }
});

// ================================================================
// COUPON VALIDATION
// ================================================================
app.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, order_subtotal_cents } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    const { data: coupon, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('is_active', true)
      .single();

    if (error || !coupon) return res.status(404).json({ error: 'Invalid or expired coupon code' });

    // Check minimum order
    if (order_subtotal_cents < coupon.minimum_order_cents) {
      return res.status(400).json({
        error: `Minimum order of $${coupon.minimum_order_cents / 100} required`
      });
    }

    // Check max uses
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ error: 'Coupon usage limit reached' });
    }

    // Check expiry
    if (coupon.valid_until && new Date(coupon.valid_until) < new Date()) {
      return res.status(400).json({ error: 'Coupon has expired' });
    }

    // Calculate discount
    let discount_cents = 0;
    if (coupon.discount_type === 'percentage') {
      discount_cents = Math.round(order_subtotal_cents * coupon.discount_value / 100);
    } else {
      discount_cents = Math.min(coupon.discount_value, order_subtotal_cents);
    }

    res.json({
      valid: true,
      code: coupon.code,
      description: coupon.description,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
      discount_cents,
    });
  } catch (err) {
    res.status(500).json({ error: 'Coupon validation failed' });
  }
});

// ================================================================
// REVIEWS
// ================================================================

// POST /api/reviews — submit a review (public)
app.post('/api/reviews', async (req, res) => {
  try {
    const { product_id, author_name, author_email, rating, title, body } = req.body;

    if (!product_id || !author_name || !rating || !body) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }

    const { data, error } = await supabase
      .from('reviews')
      .insert({
        product_id, author_name, author_email,
        rating, title, body,
        is_approved: false, // requires admin approval
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ data, message: 'Review submitted and pending approval' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ================================================================
// ORDERS (authenticated)
// ================================================================

// GET /api/orders — user's own orders
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`*, items:order_items(*, product:products(name), variant:product_variants(name))`)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/orders/:id
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`*, items:order_items(*)`)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ================================================================
// SUBSCRIPTIONS (authenticated)
// ================================================================
app.get('/api/subscriptions', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*, product:products(name, image_url), variant:product_variants(name)')
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
});

// POST /api/subscriptions/:id/pause
app.post('/api/subscriptions/:id/pause', requireAuth, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id, user_id')
      .eq('id', req.params.id)
      .single();

    if (!sub || sub.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: { behavior: 'mark_uncollectible' }
    });

    await supabase
      .from('subscriptions')
      .update({ status: 'paused' })
      .eq('id', req.params.id);

    res.json({ message: 'Subscription paused' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause subscription' });
  }
});

// POST /api/subscriptions/:id/cancel
app.post('/api/subscriptions/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id, user_id')
      .eq('id', req.params.id)
      .single();

    if (!sub || sub.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true
    });

    await supabase
      .from('subscriptions')
      .update({ status: 'cancelled', cancel_at_period_end: true })
      .eq('id', req.params.id);

    res.json({ message: 'Subscription will cancel at period end' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ================================================================
// PROFILE
// ================================================================
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    const { data, error } = await supabase
      .from('profiles')
      .update({ full_name, phone, updated_at: new Date().toISOString() })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ================================================================
// ADMIN ROUTES
// ================================================================

// Admin: Get all orders
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('orders')
      .select('*, items:order_items(count), profile:profiles(full_name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ data, count, page: Number(page), total_pages: Math.ceil(count / limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Admin: Update order status
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { status, tracking_number, tracking_url, admin_note } = req.body;

    const updates = { status, updated_at: new Date().toISOString() };
    if (tracking_number) updates.tracking_number = tracking_number;
    if (tracking_url)   updates.tracking_url = tracking_url;
    if (admin_note)     updates.admin_note = admin_note;
    if (status === 'shipped') updates.shipped_at = new Date().toISOString();
    if (status === 'delivered') updates.delivered_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Admin: Get all products
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*, category:categories(name), variants:product_variants(*)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Admin: Create product
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const {
      name, slug, tagline, description, ingredients, benefits,
      image_url, badge, category_id, is_featured, sort_order,
      variants
    } = req.body;

    // Create Stripe product
    const stripeProduct = await stripe.products.create({
      name,
      description: tagline,
      metadata: { slug }
    });

    const { data: product, error } = await supabase
      .from('products')
      .insert({
        name, slug, tagline, description, ingredients,
        benefits, image_url, badge, category_id,
        is_featured: is_featured || false,
        sort_order: sort_order || 0,
        stripe_product_id: stripeProduct.id
      })
      .select()
      .single();

    if (error) throw error;

    // Create variants if provided
    if (variants?.length) {
      for (const v of variants) {
        // Create Stripe prices
        const stripePrice = await stripe.prices.create({
          product: stripeProduct.id,
          unit_amount: v.price_cents,
          currency: 'usd',
        });

        let subPriceId = null;
        if (v.subscription_price_cents) {
          const subPrice = await stripe.prices.create({
            product: stripeProduct.id,
            unit_amount: v.subscription_price_cents,
            currency: 'usd',
            recurring: { interval: 'month' },
          });
          subPriceId = subPrice.id;
        }

        await supabase.from('product_variants').insert({
          product_id: product.id,
          name: v.name,
          sku: v.sku,
          price_cents: v.price_cents,
          compare_at_price_cents: v.compare_at_price_cents,
          subscription_price_cents: v.subscription_price_cents,
          stock_quantity: v.stock_quantity || 0,
          stripe_price_id: stripePrice.id,
          stripe_subscription_price_id: subPriceId,
        });
      }
    }

    res.status(201).json({ data: product });
  } catch (err) {
    console.error('POST /api/admin/products error:', err);
    res.status(500).json({ error: 'Failed to create product', details: err.message });
  }
});

// Admin: Approve/reject review
app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const { is_approved } = req.body;
    const { data, error } = await supabase
      .from('reviews')
      .update({ is_approved })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// Admin: Dashboard stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [ordersResult, subsResult, reviewsResult] = await Promise.all([
      supabase.from('orders').select('total_cents, status, created_at').gte('created_at', startOfMonth),
      supabase.from('subscriptions').select('status'),
      supabase.from('reviews').select('rating').eq('is_approved', true),
    ]);

    const orders = ordersResult.data || [];
    const paidOrders = orders.filter(o => ['paid','fulfilled','shipped','delivered'].includes(o.status));
    const revenue = paidOrders.reduce((s, o) => s + o.total_cents, 0);
    const avgRating = reviewsResult.data?.length
      ? reviewsResult.data.reduce((s, r) => s + r.rating, 0) / reviewsResult.data.length
      : 0;

    res.json({
      revenue_cents: revenue,
      order_count: orders.length,
      active_subscribers: subsResult.data?.filter(s => s.status === 'active').length || 0,
      avg_rating: avgRating.toFixed(1),
      review_count: reviewsResult.data?.length || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ================================================================
// STRIPE WEBHOOK HANDLER
// ================================================================
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe webhook: ${event.type}`);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await supabase
          .from('orders')
          .update({ status: 'cancelled' })
          .eq('stripe_payment_intent_id', pi.id);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await handleSubscriptionUpdated(sub);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase
          .from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'active' })
            .eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

async function handleCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  const items = JSON.parse(metadata.items || '[]');

  // Generate order number
  const orderNumber = `HC-${Date.now().toString().slice(-6)}`;

  // Find user by email
  let userId = null;
  if (session.customer_email) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', session.customer_email)
      .limit(1);
    userId = profiles?.[0]?.id || null;
  }

  // Fetch variant details for snapshots
  const variantIds = items.map(i => i.variant_id);
  const { data: variants } = await supabase
    .from('product_variants')
    .select('*, product:products(name)')
    .in('id', variantIds);

  const shipping = session.shipping_details?.address || {};
  const shippingName = session.shipping_details?.name || '';

  // Create order record
  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      user_id: userId,
      order_number: orderNumber,
      status: 'paid',
      subtotal_cents: session.amount_subtotal,
      total_cents: session.amount_total,
      shipping_cents: 0,
      currency: session.currency,
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent,
      guest_email: session.customer_email,
      shipping_name: shippingName,
      shipping_line1: shipping.line1,
      shipping_line2: shipping.line2,
      shipping_city: shipping.city,
      shipping_state: shipping.state,
      shipping_postal_code: shipping.postal_code,
      shipping_country: shipping.country,
      coupon_code: metadata.coupon_code || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create order:', error);
    return;
  }

  // Create order items
  const orderItems = items.map(item => {
    const variant = variants.find(v => v.id === item.variant_id);
    const price = item.is_subscription
      ? (variant.subscription_price_cents || variant.price_cents)
      : variant.price_cents;

    return {
      order_id: order.id,
      product_id: variant.product_id,
      variant_id: item.variant_id,
      product_name: variant.product.name,
      variant_name: variant.name,
      quantity: item.quantity,
      unit_price_cents: price,
      total_price_cents: price * item.quantity,
      is_subscription: item.is_subscription || false,
    };
  });

  await supabase.from('order_items').insert(orderItems);

  // Decrement stock
  for (const item of items) {
    const variant = variants.find(v => v.id === item.variant_id);
    await supabase
      .from('product_variants')
      .update({ stock_quantity: variant.stock_quantity - item.quantity })
      .eq('id', item.variant_id);
  }

  console.log(`✅ Order ${orderNumber} created`);
}

async function handleSubscriptionUpdated(stripeSub) {
  const userId = stripeSub.metadata?.user_id;

  const upsertData = {
    stripe_subscription_id: stripeSub.id,
    stripe_price_id: stripeSub.items.data[0]?.price?.id,
    status: stripeSub.status,
    current_period_start: new Date(stripeSub.current_period_start * 1000).toISOString(),
    current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
    cancel_at_period_end: stripeSub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };

  if (userId) upsertData.user_id = userId;

  await supabase
    .from('subscriptions')
    .upsert(upsertData, { onConflict: 'stripe_subscription_id' });
}

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log(`\n🍬 Hecharr API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Env: ${process.env.NODE_ENV || 'development'}\n`);
});

export default app;
