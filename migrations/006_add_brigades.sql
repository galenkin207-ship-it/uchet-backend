-- Личные "бригады" пользователя — просто именованные наборы сотрудников
-- для быстрого заполнения состава записи. Видны только тому, кто их создал;
-- на сами записи (records.employees) никак не влияют — там по-прежнему
-- сохраняется обычный список сотрудников по фамилиям.
-- Применить на сервере: sudo -u postgres psql -d uchet_db < add_brigades.sql

CREATE TABLE IF NOT EXISTS brigades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  members TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brigades_user_id ON brigades(user_id);

-- Права для прикладного пользователя БД (без этого — Postgres aclcheck_error при первом запросе).
GRANT SELECT, INSERT, UPDATE, DELETE ON brigades TO uchet_app;
GRANT USAGE, SELECT ON SEQUENCE brigades_id_seq TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('006_add_brigades.sql') ON CONFLICT DO NOTHING;
