-- Статус объекта: active (в работе) / archived (завершён, хранится в Истории).
-- Существующие объекты по умолчанию остаются active.
-- Права на таблицу objects уже выданы uchet_app ранее — новые колонки
-- существующей таблицы отдельного GRANT не требуют.

ALTER TABLE objects ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE objects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

INSERT INTO schema_migrations (filename) VALUES ('004_add_object_status.sql') ON CONFLICT DO NOTHING;
