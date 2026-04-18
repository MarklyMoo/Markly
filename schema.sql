-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  MARKLY DATABASE SCHEMA (PostgreSQL)
--  Updated for Lemon Squeezy payments
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Users
CREATE TABLE users (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(100) NOT NULL,
    email               VARCHAR(255) UNIQUE NOT NULL,
    password_hash       VARCHAR(255) NOT NULL,
    plan                VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
    ls_customer_id      VARCHAR(100),   -- Lemon Squeezy customer ID
    ls_subscription_id  VARCHAR(100),   -- Lemon Squeezy subscription ID
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_ls_sub ON users(ls_subscription_id);

-- Marketing plans
CREATE TABLE plans (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    audience        VARCHAR(200),
    channels        TEXT[],
    results         JSONB NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_plans_user ON plans(user_id);

-- Scheduled content
CREATE TABLE schedule (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    content         TEXT NOT NULL,
    platform        VARCHAR(50) NOT NULL,
    scheduled_at    TIMESTAMP NOT NULL,
    status          VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'published', 'failed', 'cancelled')),
    published_at    TIMESTAMP,
    error_message   TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_schedule_user ON schedule(user_id);
CREATE INDEX idx_schedule_date ON schedule(scheduled_at);

-- Auto-post queue
CREATE TABLE post_queue (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    platform        VARCHAR(50) NOT NULL,
    status          VARCHAR(20) DEFAULT 'queued' CHECK (status IN ('queued', 'publishing', 'published', 'failed')),
    published_at    TIMESTAMP,
    error_message   TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_queue_user ON post_queue(user_id);

-- Connected social media accounts
CREATE TABLE connected_accounts (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
    platform            VARCHAR(50) NOT NULL,
    access_token        TEXT NOT NULL,
    refresh_token       TEXT,
    platform_user_id    VARCHAR(200),
    expires_at          TIMESTAMP,
    created_at          TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, platform)
);
CREATE INDEX idx_connections_user ON connected_accounts(user_id);

-- Activity log
CREATE TABLE activity_log (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    action          VARCHAR(50) NOT NULL,
    details         JSONB,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_activity_user ON activity_log(user_id);
