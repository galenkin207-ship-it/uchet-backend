-- Объекты, которые пользователь вручную скрыл со своего главного экрана
-- "Объекты" (например, объект с записями, который больше не хочется видеть
-- в общем списке). В отличие от pinned_objects (принудительный показ),
-- эта таблица — принудительное скрытие; объект остаётся доступен через
-- поиск в разделе "Управление -> Объекты" и не архивируется.
-- Применить на сервере: sudo -u postgres psql -d uchet_db < add_hidden_objects.sql

CREATE TABLE IF NOT EXISTS hidden_objects (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, object_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON hidden_objects TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('007_add_hidden_objects.sql') ON CONFLICT DO NOTHING;
