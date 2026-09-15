BEGIN;

-- Заполняем имя группы (level 4) на основе имени родительской таблицы (level 3),
-- для 224 случаев, где name и variant_label группы полностью пустые
-- (не были покрыты миграцией 021, так как variant_label базовой строки
-- группы там тоже был пустым).
-- Подтверждено: каждая из этих 224 пустых групп — единственная пустая
-- группа под своей родительской таблицей, коллизий нет.
-- У родительской таблицы name всегда содержит префикс кода вида
-- "01-02-088 Пробег машин к месту работы" — срезаем префикс регэкспом.
UPDATE work_types g
SET name = regexp_replace(p.name, '^\d{2}(-\d{2,3}){1,2}\s+', '')
FROM work_types p
WHERE g.parent_id = p.id
  AND g.level = 4
  AND (g.name IS NULL OR trim(g.name) = '');

INSERT INTO schema_migrations (filename) VALUES ('023_fill_empty_group_names_from_table.sql') ON CONFLICT DO NOTHING;

COMMIT;
