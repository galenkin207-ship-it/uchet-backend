-- Таблица учёта применённых SQL-миграций. Перед каждым деплоем бэкенда
-- CI (scripts/check-migrations.js) сверяет список файлов в migrations/
-- с этой таблицей и останавливает деплой, если что-то не отмечено применённым.
--
-- КОНВЕНЦИЯ: каждая новая миграция должна заканчиваться строкой вида
--   INSERT INTO schema_migrations (filename) VALUES ('имя_файла.sql') ON CONFLICT DO NOTHING;
-- чтобы после ручного применения через psql она сразу считалась отмеченной —
-- отдельного шага для этого делать не нужно.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT now()
);

GRANT SELECT ON schema_migrations TO uchet_app;

-- Бэкфилл: миграции, применённые вручную ДО появления этой таблицы,
-- отмечаем задним числом, чтобы первая же проверка не свалилась в ошибку.
INSERT INTO schema_migrations (filename) VALUES
  ('add_notification_reads.sql'),
  ('add_object_status.sql'),
  ('add_push_subscriptions.sql'),
  ('add_audit_log.sql'),
  ('add_schema_migrations_tracking.sql')
ON CONFLICT (filename) DO NOTHING;
