-- Таблица учёта применённых SQL-миграций. Перед каждым деплоем бэкенда
-- CI (scripts/check-migrations.js) сверяет список файлов в migrations/
-- с этой таблицей и останавливает деплой, если что-то не отмечено применённым.
--
-- КОНВЕНЦИЯ: каждая новая миграция должна заканчиваться строкой вида
--   INSERT INTO schema_migrations (filename) VALUES ('имя_файла.sql') ON CONFLICT DO NOTHING;
-- чтобы после ручного применения через psql она сразу считалась отмеченной —
-- отдельного шага для этого делать не нужно.
--
-- КОНВЕНЦИЯ (нумерация): имена файлов начинаются с трёхзначного числового
-- префикса (001_, 002_, ...) в порядке реальных зависимостей — эта миграция
-- всегда идёт первой, т.к. остальные пишут в таблицу, которую она создаёт.
-- Раньше файлы были без префиксов и check-migrations.js сортировал их по
-- алфавиту, отчего эта миграция оказывалась почти в конце списка — прогнать
-- всё содержимое migrations/ по порядку на пустой базе было невозможно
-- (нельзя вставить строку в ещё не существующую таблицу). См. 000_rename_migration_filenames.sql
-- для миграции уже существующих записей schema_migrations на новые имена.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT now()
);

GRANT SELECT ON schema_migrations TO uchet_app;

-- Бэкфилл: миграции, применённые вручную ДО появления этой таблицы,
-- отмечаем задним числом, чтобы первая же проверка не свалилась в ошибку.
INSERT INTO schema_migrations (filename) VALUES
  ('000_rename_migration_filenames.sql'),
  ('003_add_notification_reads.sql'),
  ('004_add_object_status.sql'),
  ('005_add_push_subscriptions.sql'),
  ('002_add_audit_log.sql'),
  ('001_add_schema_migrations_tracking.sql')
ON CONFLICT (filename) DO NOTHING;
