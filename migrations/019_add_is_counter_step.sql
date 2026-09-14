-- Разовая классификация данных поверх уже импортированного каталога ГЭСН
-- (work_types, source='gesn_catalog'): помечает is_counter_step=true у тех
-- "шаговых" позиций (is_step_item=true), которые относятся к "чистым"
-- группам — где все шаговые позиции внутри одной родительской группы
-- ссылаются на одну и ту же базовую позицию (step_base_work_type_id).
-- Права на таблицу work_types уже выданы uchet_app ранее — новая колонка
-- существующей таблицы отдельного GRANT не требует.

ALTER TABLE work_types ADD COLUMN IF NOT EXISTS is_counter_step BOOLEAN NOT NULL DEFAULT false;

WITH clean_groups AS (
  SELECT g.id AS group_id
  FROM work_types step
  JOIN work_types g ON step.parent_id = g.id
  JOIN work_types base ON step.step_base_work_type_id = base.id AND base.parent_id = g.id
  WHERE step.is_step_item = true
  GROUP BY g.id
  HAVING count(DISTINCT step.step_base_work_type_id) = 1
)
UPDATE work_types step
SET is_counter_step = true
FROM clean_groups
WHERE step.parent_id = clean_groups.group_id
  AND step.is_step_item = true
  AND step.step_base_work_type_id IS NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('019_add_is_counter_step.sql') ON CONFLICT DO NOTHING;
