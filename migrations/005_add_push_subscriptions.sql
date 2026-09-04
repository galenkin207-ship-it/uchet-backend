-- Push-подписки браузера/PWA (Web Push API).
-- Применить на сервере: sudo -u postgres psql -d uchet_db < add_push_subscriptions.sql

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- Права для прикладного пользователя БД (без этого — Postgres aclcheck_error при первом запросе).
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO uchet_app;
GRANT USAGE, SELECT ON SEQUENCE push_subscriptions_id_seq TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('005_add_push_subscriptions.sql') ON CONFLICT DO NOTHING;
