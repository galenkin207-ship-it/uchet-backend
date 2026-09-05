-- Восстановление пароля по email. email необязателен (не у всех пользователей
-- он есть/собран) — форма "забыли пароль" всегда отвечает одинаково, есть
-- такой email в базе или нет, чтобы нельзя было проверять чужие email на
-- регистрацию в системе перебором.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- Не строгий UNIQUE на весь столбец (некоторые пользователи вообще без email,
-- то есть NULL — обычный UNIQUE считал бы два NULL конфликтующими в некоторых
-- СУБД, в Postgres NULL не конфликтует сам с собой, но для ясности делаем
-- частичный индекс явно только по непустым и без учёта регистра).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON users (lower(email)) WHERE email IS NOT NULL;

-- Одноразовые токены сброса пароля. Храним ХЕШ токена (сам токен уходит только
-- в письмо пользователю) — так же, как пароли не хранятся в открытом виде,
-- утечка базы не даёт возможности сбросить пароль по украденным токенам.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_token_hash_idx ON password_reset_tokens (token_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO uchet_app;
GRANT USAGE, SELECT ON SEQUENCE password_reset_tokens_id_seq TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('014_add_password_reset.sql') ON CONFLICT DO NOTHING;
