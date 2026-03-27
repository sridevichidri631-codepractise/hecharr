-- ================================================================
-- HECHARR — Supabase Database Schema
-- Run in: Supabase Dashboard > SQL Editor
-- ================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ================================================================
-- PROFILES  (extends Supabase auth.users)
-- ================================================================
CREATE TABLE profiles (
  id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  full_name           TEXT,
  phone               TEXT,
  avatar_url          TEXT,
  stripe_customer_id  TEXT UNIQUE,
  is_admin            BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"   ON profiles FOR SELECT  USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE  USING (auth.uid() = id);
CREATE POLICY "Admins have full access"      ON profiles FOR ALL     USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- Auto-create profile row when user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ================================================================
-- CATEGORIES
-- ================================================================
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  description TEXT,
  image_url   TEXT,
  sort_order  INTEGER DEFAULT 0,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read active categories" ON categories FOR SELECT USING (is_active = TRUE);
CREATE POLICY "Admins manage categories"      ON categories FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- PRODUCTS
-- ================================================================
CREATE TABLE products (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id       UUID REFERENCES categories(id),
  name              TEXT NOT NULL,
  slug              TEXT UNIQUE NOT NULL,
  tagline           TEXT,
  description       TEXT,
  ingredients       TEXT,
  benefits          TEXT[],
  image_url         TEXT,
  image_gallery     TEXT[],
  badge             TEXT,                  -- "Best Seller", "New", etc.
  is_active         BOOLEAN DEFAULT TRUE,
  is_featured       BOOLEAN DEFAULT FALSE,
  sort_order        INTEGER DEFAULT 0,
  stripe_product_id TEXT UNIQUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read active products" ON products FOR SELECT USING (is_active = TRUE);
CREATE POLICY "Admins manage products"      ON products FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- PRODUCT VARIANTS  (e.g. 28-pack vs 56-pack)
-- ================================================================
CREATE TABLE product_variants (
  id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id                   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name                         TEXT NOT NULL,             -- "28 Packs (1 Month)"
  sku                          TEXT UNIQUE NOT NULL,
  price_cents                  INTEGER NOT NULL,           -- one-time price
  compare_at_price_cents       INTEGER,                   -- crossed-out original price
  subscription_price_cents     INTEGER,                   -- discounted recurring price
  weight_grams                 INTEGER,
  stock_quantity               INTEGER DEFAULT 0,
  is_active                    BOOLEAN DEFAULT TRUE,
  stripe_price_id              TEXT,                      -- one-time Stripe price
  stripe_subscription_price_id TEXT,                     -- recurring Stripe price
  created_at                   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read active variants" ON product_variants FOR SELECT USING (is_active = TRUE);
CREATE POLICY "Admins manage variants"      ON product_variants FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- ADDRESSES
-- ================================================================
CREATE TABLE addresses (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL,
  line1        TEXT NOT NULL,
  line2        TEXT,
  city         TEXT NOT NULL,
  state        TEXT NOT NULL,
  postal_code  TEXT NOT NULL,
  country      TEXT NOT NULL DEFAULT 'US',
  is_default   BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own addresses" ON addresses FOR ALL USING (auth.uid() = user_id);

-- ================================================================
-- ORDERS
-- ================================================================
CREATE TYPE order_status AS ENUM (
  'pending', 'processing', 'paid', 'fulfilled',
  'shipped', 'delivered', 'cancelled', 'refunded'
);

CREATE TABLE orders (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID REFERENCES profiles(id),
  order_number            TEXT UNIQUE NOT NULL,
  status                  order_status DEFAULT 'pending',
  -- Amounts (all in cents)
  subtotal_cents          INTEGER NOT NULL,
  discount_cents          INTEGER DEFAULT 0,
  shipping_cents          INTEGER DEFAULT 0,
  tax_cents               INTEGER DEFAULT 0,
  total_cents             INTEGER NOT NULL,
  currency                TEXT DEFAULT 'usd',
  -- Stripe references
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_session_id        TEXT UNIQUE,
  -- Shipping snapshot
  shipping_name           TEXT,
  shipping_line1          TEXT,
  shipping_line2          TEXT,
  shipping_city           TEXT,
  shipping_state          TEXT,
  shipping_postal_code    TEXT,
  shipping_country        TEXT,
  -- Fulfillment
  tracking_number         TEXT,
  tracking_url            TEXT,
  shipped_at              TIMESTAMPTZ,
  delivered_at            TIMESTAMPTZ,
  -- Notes
  customer_note           TEXT,
  admin_note              TEXT,
  coupon_code             TEXT,
  guest_email             TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own orders"    ON orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins manage all orders" ON orders FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- ORDER ITEMS
-- ================================================================
CREATE TABLE order_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES products(id),
  variant_id        UUID NOT NULL REFERENCES product_variants(id),
  -- Snapshots (stored at time of purchase so edits don't break history)
  product_name      TEXT NOT NULL,
  variant_name      TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  unit_price_cents  INTEGER NOT NULL,
  total_price_cents INTEGER NOT NULL,
  is_subscription   BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own order items" ON order_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM orders WHERE id = order_id AND user_id = auth.uid())
);
CREATE POLICY "Admins manage order items" ON order_items FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- SUBSCRIPTIONS
-- ================================================================
CREATE TYPE subscription_status AS ENUM (
  'active', 'paused', 'cancelled', 'past_due', 'unpaid'
);

CREATE TABLE subscriptions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID NOT NULL REFERENCES profiles(id),
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_price_id        TEXT NOT NULL,
  product_id             UUID REFERENCES products(id),
  variant_id             UUID REFERENCES product_variants(id),
  status                 subscription_status DEFAULT 'active',
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN DEFAULT FALSE,
  quantity               INTEGER DEFAULT 1,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own subscriptions"    ON subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins manage all subscriptions" ON subscriptions FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- REVIEWS
-- ================================================================
CREATE TABLE reviews (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id              UUID REFERENCES profiles(id),
  author_name          TEXT NOT NULL,
  author_email         TEXT,
  rating               INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title                TEXT,
  body                 TEXT NOT NULL,
  is_verified_purchase BOOLEAN DEFAULT FALSE,
  is_approved          BOOLEAN DEFAULT FALSE,
  helpful_count        INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read approved reviews" ON reviews FOR SELECT USING (is_approved = TRUE);
CREATE POLICY "Anyone can submit reviews"    ON reviews FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "Admins manage reviews"        ON reviews FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- COUPONS
-- ================================================================
CREATE TABLE coupons (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code                 TEXT UNIQUE NOT NULL,
  description          TEXT,
  discount_type        TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value       INTEGER NOT NULL,     -- % (0-100) or cents
  minimum_order_cents  INTEGER DEFAULT 0,
  max_uses             INTEGER,              -- NULL = unlimited
  used_count           INTEGER DEFAULT 0,
  valid_from           TIMESTAMPTZ DEFAULT NOW(),
  valid_until          TIMESTAMPTZ,
  is_active            BOOLEAN DEFAULT TRUE,
  stripe_coupon_id     TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read coupons"    ON coupons FOR SELECT USING (is_active = TRUE);
CREATE POLICY "Admins manage coupons"  ON coupons FOR ALL   USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- ANALYTICS EVENTS  (lightweight event tracking)
-- ================================================================
CREATE TABLE analytics_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES profiles(id),
  event_type  TEXT NOT NULL,   -- 'page_view', 'add_to_cart', 'checkout_started', 'purchase'
  properties  JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert events" ON analytics_events FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "Admins view analytics"    ON analytics_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- ================================================================
-- SEED DATA
-- ================================================================

-- Categories
INSERT INTO categories (name, slug, description, sort_order) VALUES
  ('Health & Vitamins', 'health', 'Comprehensive daily nutrition gummies', 1),
  ('Beauty & Glow',     'beauty', 'Collagen, biotin & beauty-focused blends', 2),
  ('Kids',              'kids',   'Safe, fun gummies formulated for children', 3);

-- Products
INSERT INTO products (name, slug, tagline, description, benefits, badge, is_featured, category_id)
SELECT
  'Daily Vitality',
  'daily-vitality',
  '60 nutrients in one delicious grab-and-go pack',
  'The most comprehensive daily gummy on the market. Packed with 21+ vitamins, prebiotic fiber, adaptogens, and whole-food superfoods — all in one convenient snack pack.',
  ARRAY['All-day energy', 'Immune defense', 'Gut health & digestion', 'Mental clarity', 'Stress resilience'],
  'Best Seller',
  TRUE,
  id
FROM categories WHERE slug = 'health';

INSERT INTO products (name, slug, tagline, description, benefits, badge, is_featured, category_id)
SELECT
  'Glow & Radiance',
  'glow-radiance',
  'Collagen, biotin & vitamin E for luminous skin',
  'Your daily beauty ritual, reimagined. Marine collagen peptides, biotin, vitamin E, and hyaluronic acid work together to give you radiant skin, strong nails, and glossy hair.',
  ARRAY['Skin radiance', 'Hair growth & shine', 'Nail strengthening', 'Anti-aging support'],
  NULL,
  TRUE,
  id
FROM categories WHERE slug = 'beauty';

INSERT INTO products (name, slug, tagline, description, benefits, badge, is_featured, category_id)
SELECT
  'Little Champions',
  'little-champions',
  'Complete nutrition made for growing kids',
  'Everything growing kids need, in a gummy they will actually beg for. Zero artificial colors or flavors. Pediatrician-reviewed formula.',
  ARRAY['Immune support', 'Healthy bone growth', 'Brain development', 'All-day energy for play'],
  'Kids',
  TRUE,
  id
FROM categories WHERE slug = 'kids';

INSERT INTO products (name, slug, tagline, description, benefits, badge, is_featured, category_id)
SELECT
  'Calm & Sleep',
  'calm-sleep',
  'Magnesium, L-theanine & melatonin for deep rest',
  'Fall asleep faster, stay asleep longer, and wake up refreshed. Our sleep formula combines magnesium glycinate, L-theanine, passionflower, and gentle melatonin.',
  ARRAY['Faster sleep onset', 'Deeper sleep quality', 'Stress & anxiety relief', 'Morning recovery'],
  'New',
  FALSE,
  id
FROM categories WHERE slug = 'health';

-- Variants for Daily Vitality
INSERT INTO product_variants (product_id, name, sku, price_cents, compare_at_price_cents, subscription_price_cents, stock_quantity)
SELECT id, '28 Packs — 1 Month Supply', 'HC-DV-28', 5900, 7900, 5015, 500
FROM products WHERE slug = 'daily-vitality';

INSERT INTO product_variants (product_id, name, sku, price_cents, compare_at_price_cents, subscription_price_cents, stock_quantity)
SELECT id, '56 Packs — 2 Month Supply', 'HC-DV-56', 10900, 14900, 9265, 250
FROM products WHERE slug = 'daily-vitality';

-- Variants for Glow & Radiance
INSERT INTO product_variants (product_id, name, sku, price_cents, compare_at_price_cents, subscription_price_cents, stock_quantity)
SELECT id, '28 Packs — 1 Month Supply', 'HC-GR-28', 5400, 6900, 4590, 400
FROM products WHERE slug = 'glow-radiance';

-- Variants for Little Champions
INSERT INTO product_variants (product_id, name, sku, price_cents, compare_at_price_cents, subscription_price_cents, stock_quantity)
SELECT id, '28 Packs — 1 Month Supply', 'HC-LC-28', 4900, 6500, 4165, 300
FROM products WHERE slug = 'little-champions';

-- Variants for Calm & Sleep
INSERT INTO product_variants (product_id, name, sku, price_cents, compare_at_price_cents, subscription_price_cents, stock_quantity)
SELECT id, '28 Packs — 1 Month Supply', 'HC-CS-28', 5200, 6800, 4420, 200
FROM products WHERE slug = 'calm-sleep';

-- Coupons
INSERT INTO coupons (code, description, discount_type, discount_value, minimum_order_cents, is_active) VALUES
  ('WELCOME20', '20% off your first order', 'percentage', 20, 0, TRUE),
  ('FIRST10',   '$10 off any order',         'fixed', 1000, 3000, TRUE),
  ('SPRING25',  '25% off — spring special',  'percentage', 25, 4900, TRUE);

-- Approved Reviews
INSERT INTO reviews (product_id, author_name, rating, title, body, is_verified_purchase, is_approved)
SELECT
  id, 'Sarah M.', 5,
  'Actually changed my routine!',
  'I have tried every greens powder on the market. They always taste like grass clippings. Hecharr actually tastes like a treat and I can feel the difference in my energy within a week. Genuinely shocked.',
  TRUE, TRUE
FROM products WHERE slug = 'daily-vitality';

INSERT INTO reviews (product_id, author_name, rating, title, body, is_verified_purchase, is_approved)
SELECT
  id, 'James T.', 5,
  'My pharmacist approves',
  'Showed the ingredient list to my pharmacist and she was impressed. High-quality forms of each nutrient, no junk fillers. Plus they taste amazing.',
  TRUE, TRUE
FROM products WHERE slug = 'daily-vitality';

INSERT INTO reviews (product_id, author_name, rating, title, body, is_verified_purchase, is_approved)
SELECT
  id, 'Jordan K.', 5,
  'My skin has never looked better',
  'Started the Glow gummies and within 3 weeks people kept asking what skincare I was using. The secret is these gummies lol. 100% repurchasing.',
  TRUE, TRUE
FROM products WHERE slug = 'glow-radiance';

INSERT INTO reviews (product_id, author_name, rating, title, body, is_verified_purchase, is_approved)
SELECT
  id, 'Monica R.', 5,
  'My kids fight over who gets theirs first',
  'As a mom, getting my kids to take supplements has always been a battle. With Hecharr they literally ask for their gummies every morning. That is a miracle.',
  TRUE, TRUE
FROM products WHERE slug = 'little-champions';
