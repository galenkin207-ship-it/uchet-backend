-- Статус вида работы: active / archived (архивация вместо жёсткого удаления,
-- чтобы record_items.work_type_id не терял связь со справочником).
-- Существующие виды работ по умолчанию остаются active.
-- Права на таблицу work_types уже выданы uchet_app ранее — новые колонки
-- существующей таблицы отдельного GRANT не требуют.

ALTER TABLE work_types ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

INSERT INTO schema_migrations (filename) VALUES ('016_add_work_type_status.sql') ON CONFLICT DO NOTHING;
