-- Дерево видов работ: поддержка иерархии (разделы/подразделы/позиции),
-- привязки к сборникам расценок (ГЭСН и т.п.) и позиций-"шагов" (когда
-- одна позиция справочника при выборе разворачивается в несколько формул
-- расчёта объёма — step_base_work_type_id указывает на "базовую" позицию,
-- от которой считается шаг).
-- Права на таблицу work_types уже выданы uchet_app ранее — новые колонки
-- существующей таблицы отдельного GRANT не требуют.

ALTER TABLE work_types ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 5;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS catalog_type VARCHAR(30);
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS gesn_code VARCHAR(30);
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS labor_hours NUMERIC(12,5);
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS work_composition TEXT;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS is_step_item BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS step_base_work_type_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS step_unit_label VARCHAR(50);
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_work_types_parent_id ON work_types(parent_id);
CREATE INDEX IF NOT EXISTS idx_work_types_level ON work_types(level);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_types_gesn_code ON work_types(gesn_code) WHERE gesn_code IS NOT NULL;

-- Синтетический корень для уже существующих (legacy) позиций. Guard по
-- source='legacy_root' — чтобы повторный прогон файла (тем же способом,
-- каким уже защищена вставка в schema_migrations ниже) не плодил вторую
-- корневую строку.
INSERT INTO work_types (name, unit, price, status, level, source, sort_order)
SELECT 'Существующие виды работ (до обновления)', '-', 0, 'active', 1, 'legacy_root', 0
WHERE NOT EXISTS (SELECT 1 FROM work_types WHERE source = 'legacy_root');

UPDATE work_types
SET parent_id = (SELECT id FROM work_types WHERE source = 'legacy_root'),
    source = 'legacy'
WHERE source = 'manual';

INSERT INTO schema_migrations (filename) VALUES ('017_add_work_type_tree_columns.sql') ON CONFLICT DO NOTHING;
