const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'markly-secret-change-me';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Auto-create tables on startup ──
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        plan VARCHAR(20) DEFAULT 'free',
        ls_customer_id VARCHAR(100),
        ls_subscription_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        audience VARCHAR(200),
        channels TEXT[],
        results JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS schedule (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        scheduled_at TIMESTAMP NOT NULL,
        status VARCHAR(20) DEFAULT 'scheduled',
        published_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS post_queue (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'queued',
        published_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connected_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(50) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        platform_user_id VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, platform)
      );
    `);
    console.log('Database tables ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// ── Auth Middleware ──
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Health check ──
app.get('/', (req, res) => res.json({ status: 'Markly API is running' }));

// ── Signup ──
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
  } catch (err) { console.error('Signup error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ── Login ──
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, token });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ── Get current user ──
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, plan, created_at FROM users WHERE id = $1', [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Generate plan ──
app.post('/api/plans/generate', auth, async (req, res) => {
  try {
    const { name, description, audience, channels } = req.body;

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
  } catch (err) { console.error('Generate error:', err); res.status(500).json({ error: 'Generation failed' }); }
});

// ── List plans ──
app.get('/api/plans', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ plans: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Update plan ──
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

// ── Delete plan ──
app.delete('/api/plans/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.listen(PORT, () => console.log(`Markly server running on port ${PORT}`));
