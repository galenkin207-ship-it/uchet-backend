BEGIN;

-- Старый номер позиции из пользовательского справочника (import_data.json),
-- только для listьев (level=5), импортированных scripts/import-user-catalog.js —
-- нужен для сверки/отладки соответствия новых записей исходному файлу.
-- Права на таблицу work_types уже выданы uchet_app ранее — новая колонка
-- существующей таблицы отдельного GRANT не требует.
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS legacy_num INTEGER;
CREATE INDEX IF NOT EXISTS idx_work_types_legacy_num ON work_types(legacy_num) WHERE legacy_num IS NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('024_add_legacy_num.sql') ON CONFLICT DO NOTHING;

COMMIT;
