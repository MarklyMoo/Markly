// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MARKLY BACKEND SERVER
//  Express.js + PostgreSQL + Lemon Squeezy + Social Media APIs
//  Lemon Squeezy handles: payments, tax, compliance, subscriptions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ── Lemon Squeezy webhook needs raw body, so we set up parsing carefully ──
app.use('/api/webhooks/lemonsqueezy', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

// ── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'markly-secret-change-me';
const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LS_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID;
const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Lemon Squeezy API helper ────────────────────────────
const lsApi = axios.create({
  baseURL: 'https://api.lemonsqueezy.com/v1',
  headers: {
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'Authorization': `Bearer ${LS_API_KEY}`,
  },
});

// ── Database ────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Auth Middleware ──────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Plan limits ─────────────────────────────────────────
const PLAN_LIMITS = {
  free: { plans: 3, regen: 5, queue: 10 },
  pro: { plans: 999, regen: 999, queue: 999 },
  business: { plans: 999, regen: 999, queue: 999 },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTH ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, plan) VALUES ($1, $2, $3, $4) RETURNING id, name, email, plan, created_at',
      [name, email.toLowerCase(), hash, 'free']
    );

    const token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: result.rows[0], token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Get current user
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, plan, ls_customer_id, ls_subscription_id, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LEMON SQUEEZY PAYMENT ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Variant IDs for your Lemon Squeezy products
// You create these in your LS dashboard: Products → Create Product
const LS_VARIANTS = {
  pro: process.env.LS_PRO_VARIANT_ID,       // e.g. "123456"
  business: process.env.LS_BIZ_VARIANT_ID,  // e.g. "123457"
};

// Create checkout session — returns a Lemon Squeezy checkout URL
app.post('/api/payments/checkout', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    const variantId = LS_VARIANTS[planId];
    if (!variantId) return res.status(400).json({ error: 'Invalid plan' });

    // Get user info to pre-fill checkout
    const userRow = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
    const user = userRow.rows[0];

    // Create checkout via Lemon Squeezy API
    const response = await lsApi.post('/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: user.email,
            name: user.name,
            custom: {
              user_id: String(req.user.id),  // Pass our user ID so webhook can match
            },
          },
          checkout_options: {
            button_color: '#6C5CE7',
          },
          product_options: {
            redirect_url: `${process.env.FRONTEND_URL}/settings?upgraded=true`,
          },
        },
        relationships: {
          store: {
            data: { type: 'stores', id: LS_STORE_ID },
          },
          variant: {
            data: { type: 'variants', id: variantId },
          },
        },
      },
    });

    const checkoutUrl = response.data.data.attributes.url;
    res.json({ url: checkoutUrl });
  } catch (err) {
    console.error('Checkout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// Get customer portal URL — lets users manage their own subscription
app.post('/api/payments/portal', auth, async (req, res) => {
  try {
    const userRow = await pool.query(
      'SELECT ls_subscription_id FROM users WHERE id = $1', [req.user.id]
    );
    const subId = userRow.rows[0]?.ls_subscription_id;
    if (!subId) return res.status(400).json({ error: 'No active subscription' });

    // Get the subscription's customer portal URL
    const response = await lsApi.get(`/subscriptions/${subId}`);
    const portalUrl = response.data.data.attributes.urls.customer_portal;

    res.json({ url: portalUrl });
  } catch (err) {
    console.error('Portal error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get portal' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LEMON SQUEEZY WEBHOOK
//  Handles: subscription_created, subscription_updated,
//           subscription_cancelled, subscription_expired
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/webhooks/lemonsqueezy', async (req, res) => {
  try {
    // 1. Verify webhook signature
    const rawBody = req.body;
    const signature = req.headers['x-signature'];

    if (!signature || !LS_WEBHOOK_SECRET) {
      return res.status(400).json({ error: 'Missing signature or secret' });
    }

    const hmac = crypto.createHmac('sha256', LS_WEBHOOK_SECRET);
    const digest = hmac.update(rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 2. Parse the event
    const event = JSON.parse(rawBody.toString());
    const eventName = event.meta.event_name;
    const customData = event.meta.custom_data || {};
    const userId = customData.user_id;
    const attrs = event.data.attributes;

    console.log(`[Webhook] ${eventName} for user ${userId}`);

    // 3. Determine plan from variant ID
    let plan = 'free';
    const variantId = String(attrs.variant_id);
    if (variantId === LS_VARIANTS.pro) plan = 'pro';
    else if (variantId === LS_VARIANTS.business) plan = 'business';

    // 4. Handle different events
    switch (eventName) {

      case 'subscription_created': {
        // New subscription — upgrade user
        await pool.query(
          `UPDATE users SET
            plan = $1,
            ls_customer_id = $2,
            ls_subscription_id = $3,
            updated_at = NOW()
          WHERE id = $4`,
          [plan, String(attrs.customer_id), String(event.data.id), userId]
        );
        console.log(`[Webhook] User ${userId} upgraded to ${plan}`);
        break;
      }

      case 'subscription_updated': {
        // Plan changed (upgrade/downgrade) or payment updated
        const status = attrs.status; // active, past_due, paused, cancelled, expired

        if (status === 'active') {
          await pool.query(
            `UPDATE users SET plan = $1, ls_subscription_id = $2, updated_at = NOW() WHERE id = $3`,
            [plan, String(event.data.id), userId]
          );
        } else if (status === 'past_due' || status === 'paused') {
          // Keep current plan but flag it — LS will retry payment
          console.log(`[Webhook] User ${userId} subscription ${status}`);
        } else if (status === 'cancelled' || status === 'expired') {
          // Grace period — user keeps access until ends_at
          // We'll downgrade when subscription_expired fires
          console.log(`[Webhook] User ${userId} subscription ${status}, ends at ${attrs.ends_at}`);
        }
        break;
      }

      case 'subscription_cancelled': {
        // User cancelled — they keep access until end of billing period
        // ends_at tells us when to actually downgrade
        console.log(`[Webhook] User ${userId} cancelled, access until ${attrs.ends_at}`);
        break;
      }

      case 'subscription_expired': {
        // Subscription fully expired — downgrade to free
        await pool.query(
          `UPDATE users SET plan = 'free', ls_subscription_id = NULL, updated_at = NOW()
           WHERE ls_subscription_id = $1`,
          [String(event.data.id)]
        );
        console.log(`[Webhook] User downgraded to free (subscription expired)`);
        break;
      }

      case 'subscription_payment_success': {
        // Renewal payment went through — log it
        console.log(`[Webhook] Payment success for user ${userId}`);
        break;
      }

      case 'subscription_payment_failed': {
        // Payment failed — LS will retry automatically (dunning)
        console.log(`[Webhook] Payment failed for user ${userId}, LS will retry`);
        break;
      }

      default:
        console.log(`[Webhook] Unhandled event: ${eventName}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MARKETING PLAN ROUTES (same as before)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Generate marketing plan
app.post('/api/plans/generate', auth, async (req, res) => {
  try {
    const { name, description, audience, channels } = req.body;

    // Check plan limits
    const planCount = await pool.query('SELECT COUNT(*) FROM plans WHERE user_id = $1', [req.user.id]);
    const userRow = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
    const limit = PLAN_LIMITS[userRow.rows[0]?.plan || 'free']?.plans || 3;
    if (parseInt(planCount.rows[0].count) >= limit) {
      return res.status(403).json({ error: 'Plan limit reached. Upgrade to create more.' });
    }

    const prompt = `You are an expert marketing strategist. Generate a complete marketing plan.
Business: ${name}
Description: ${description}
Target Audience: ${audience}
Marketing Channels: ${channels.join(", ")}

Respond ONLY with valid JSON:
{"strategy":{"summary":"...","tone":"...","posting_frequency":"...","key_themes":["...","...","..."]},"social_posts":[{"platform":"...","content":"...","type":"...","best_time":"..."}],"email_sequences":[{"name":"...","subject":"...","preview":"...","body":"..."}],"ad_copy":[{"platform":"...","headline":"...","body":"...","cta":"...","targeting_tip":"..."}]}
Generate 4+ social posts, 2 emails, 2 ads. No markdown.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content.map(c => c.text || '').join('');
    const results = JSON.parse(text.replace(/```json|```/g, '').trim());

    const plan = await pool.query(
      `INSERT INTO plans (user_id, name, description, audience, channels, results)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, name, description, audience, channels, JSON.stringify(results)]
    );

    res.json({ plan: plan.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Generation failed' }); }
});

// List plans
app.get('/api/plans', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ plans: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Get single plan
app.get('/api/plans/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Update plan content
app.patch('/api/plans/:id', auth, async (req, res) => {
  try {
    const { results } = req.body;
    const result = await pool.query(
      'UPDATE plans SET results = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
      [JSON.stringify(results), req.params.id, req.user.id]
    );
    res.json({ plan: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Delete plan
app.delete('/api/plans/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Regenerate single item
app.post('/api/plans/:id/regenerate', auth, async (req, res) => {
  try {
    const { section, index, platform } = req.body;
    const planRow = await pool.query('SELECT * FROM plans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!planRow.rows.length) return res.status(404).json({ error: 'Plan not found' });

    const plan = planRow.rows[0];
    const typeMap = { social_posts: 'social_post', email_sequences: 'email', ad_copy: 'ad' };
    const structMap = {
      social_post: '{"platform":"...","content":"...","type":"...","best_time":"..."}',
      email: '{"name":"...","subject":"...","preview":"...","body":"..."}',
      ad: '{"platform":"...","headline":"...","body":"...","cta":"...","targeting_tip":"..."}',
    };
    const t = typeMap[section];

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Generate ONE new ${t} for "${plan.name}" (${plan.description}), audience: ${plan.audience}, platform: ${platform}. ONLY valid JSON: ${structMap[t]}. No markdown.`,
      }],
    });

    const text = message.content.map(c => c.text || '').join('');
    const item = JSON.parse(text.replace(/```json|```/g, '').trim());

    const results = typeof plan.results === 'string' ? JSON.parse(plan.results) : plan.results;
    results[section][index] = item;
    await pool.query('UPDATE plans SET results = $1 WHERE id = $2', [JSON.stringify(results), plan.id]);

    res.json({ item, results });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Regeneration failed' }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCHEDULE & QUEUE ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/schedule', auth, async (req, res) => {
  try {
    const { content, platform, scheduled_at } = req.body;
    const result = await pool.query(
      'INSERT INTO schedule (user_id, content, platform, scheduled_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, content, platform, scheduled_at]
    );
    res.json({ item: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/schedule', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM schedule WHERE user_id = $1 ORDER BY scheduled_at ASC', [req.user.id]);
    res.json({ items: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/schedule/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM schedule WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/queue', auth, async (req, res) => {
  try {
    const { content, platform } = req.body;
    const result = await pool.query(
      'INSERT INTO post_queue (user_id, content, platform, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, content, platform, 'queued']
    );
    res.json({ item: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/queue', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM post_queue WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ items: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/queue/:id/publish', auth, async (req, res) => {
  try {
    const item = await pool.query('SELECT * FROM post_queue WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!item.rows.length) return res.status(404).json({ error: 'Not found' });

    const post = item.rows[0];
    const account = await pool.query(
      'SELECT * FROM connected_accounts WHERE user_id = $1 AND platform = $2',
      [req.user.id, post.platform.toLowerCase().split(' ')[0]]
    );
    if (!account.rows.length) return res.status(400).json({ error: 'Account not connected' });

    const acc = account.rows[0];
    await postToSocial(acc.platform, acc.access_token, post.content, acc.platform_user_id);
    await pool.query("UPDATE post_queue SET status = 'published', published_at = NOW() WHERE id = $1", [post.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Publish failed' }); }
});

app.delete('/api/queue/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM post_queue WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SOCIAL MEDIA CONNECTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const OAUTH_CONFIG = {
  facebook: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scope: 'pages_manage_posts,pages_read_engagement',
    clientId: process.env.FB_APP_ID,
    clientSecret: process.env.FB_APP_SECRET,
  },
  instagram: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scope: 'instagram_basic,instagram_content_publish',
    clientId: process.env.FB_APP_ID,
    clientSecret: process.env.FB_APP_SECRET,
  },
  twitter: {
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scope: 'tweet.read tweet.write users.read offline.access',
    clientId: process.env.TWITTER_CLIENT_ID,
    clientSecret: process.env.TWITTER_CLIENT_SECRET,
  },
  linkedin: {
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scope: 'w_member_social',
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
  },
};

app.get('/api/connect/:platform', auth, (req, res) => {
  const config = OAUTH_CONFIG[req.params.platform];
  if (!config) return res.status(400).json({ error: 'Unsupported platform' });

  const state = jwt.sign({ userId: req.user.id, platform: req.params.platform }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: config.clientId, redirect_uri: `${process.env.BACKEND_URL}/api/connect/callback`,
    scope: config.scope, response_type: 'code', state,
  });
  res.json({ url: `${config.authUrl}?${params}` });
});

app.get('/api/connect/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { userId, platform } = jwt.verify(state, JWT_SECRET);
    const config = OAUTH_CONFIG[platform];

    const tokenRes = await axios.post(config.tokenUrl, new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret, code,
      redirect_uri: `${process.env.BACKEND_URL}/api/connect/callback`, grant_type: 'authorization_code',
    }));

    const { access_token, refresh_token } = tokenRes.data;
    let platformUserId = '';

    if (platform === 'facebook' || platform === 'instagram') {
      const me = await axios.get(`https://graph.facebook.com/me?access_token=${access_token}`);
      platformUserId = me.data.id;
    } else if (platform === 'twitter') {
      const me = await axios.get('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${access_token}` } });
      platformUserId = me.data.data.id;
    } else if (platform === 'linkedin') {
      const me = await axios.get('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
      platformUserId = me.data.sub;
    }

    await pool.query(
      `INSERT INTO connected_accounts (user_id, platform, access_token, refresh_token, platform_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, platform) DO UPDATE SET access_token = $3, refresh_token = $4, platform_user_id = $5`,
      [userId, platform, access_token, refresh_token || '', platformUserId]
    );

    res.redirect(`${process.env.FRONTEND_URL}/connections?connected=${platform}`);
  } catch (err) { console.error(err); res.redirect(`${process.env.FRONTEND_URL}/connections?error=true`); }
});

app.get('/api/connections', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT platform, platform_user_id, created_at FROM connected_accounts WHERE user_id = $1', [req.user.id]);
    res.json({ connections: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/connections/:platform', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM connected_accounts WHERE user_id = $1 AND platform = $2', [req.user.id, req.params.platform]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SOCIAL POSTING ENGINE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function postToSocial(platform, accessToken, content, platformUserId) {
  switch (platform) {
    case 'facebook': {
      return (await axios.post(`https://graph.facebook.com/v18.0/${platformUserId}/feed`, { message: content, access_token: accessToken })).data;
    }
    case 'twitter': {
      return (await axios.post('https://api.twitter.com/2/tweets', { text: content }, { headers: { Authorization: `Bearer ${accessToken}` } })).data;
    }
    case 'linkedin': {
      return (await axios.post('https://api.linkedin.com/v2/ugcPosts', {
        author: `urn:li:person:${platformUserId}`, lifecycleState: 'PUBLISHED',
        specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: content }, shareMediaCategory: 'NONE' } },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      }, { headers: { Authorization: `Bearer ${accessToken}` } })).data;
    }
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

// ── Start ────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Markly server running on port ${PORT}`));
