-- Признак того, что вид работы имеет цену (в отличие от разделов/подразделов
-- дерева, для которых цена не задаётся). По умолчанию true — существующие
-- позиции справочника ценовые.
-- Права на таблицу work_types уже выданы uchet_app ранее — новая колонка
-- существующей таблицы отдельного GRANT не требует.

ALTER TABLE work_types ADD COLUMN IF NOT EXISTS has_price BOOLEAN NOT NULL DEFAULT true;

INSERT INTO schema_migrations (filename) VALUES ('018_add_work_type_has_price.sql') ON CONFLICT DO NOTHING;
