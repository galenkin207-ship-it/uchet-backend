-- Скрытые ("удалённые") уведомления по пользователям. Сами заявки/сообщения
-- никуда не удаляются — уведомление лишь перестаёт показываться в списке
-- у конкретного пользователя (аналогично notification_reads/hidden_objects).
-- Применить на сервере: sudo -u postgres psql -d uchet_db < add_notification_hides.sql

CREATE TABLE IF NOT EXISTS notification_hides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_hides TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('add_notification_hides.sql') ON CONFLICT DO NOTHING;
