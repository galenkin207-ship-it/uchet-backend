BEGIN;

-- Коды ГЭСН официально уникальны только внутри своей книги (сборника), не
-- глобально — на это наткнулись при импорте ГЭСНм08: 31 позиция (трансформаторы
-- 08-01-001-xx и др.) имеет тот же "код", что уже занят другим сборником
-- (ГЭСН08 "Конструкции из кирпича и блоков"), хотя это совершенно разные
-- позиции. Раньше это было физически невозможно вставить — на gesn_code стоял
-- ГЛОБАЛЬНЫЙ уникальный индекс (idx_work_types_gesn_code, миграция 017).
-- Эта миграция переносит уникальность на пару (sbornik_id, gesn_code).

-- (a) sbornik_id — id корневого узла (level=1) для каждой строки work_types;
-- для самих level=1 строк sbornik_id = собственный id. ON DELETE SET NULL —
-- тот же паттерн, что и у parent_id/step_base_work_type_id (миграция 017):
-- если сборник когда-нибудь удалят, дочерние строки не должны падать.
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS sbornik_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL;

-- (b) Backfill одним UPDATE поверх рекурсивного CTE (не построчно в JS —
-- ~18000+ строк). Поднимаемся по parent_id от каждой строки до узла без
-- родителя (level=1, parent_id IS NULL) — для самой level=1 строки это она
-- сама (базовый случай CTE уже удовлетворяет условию cur_parent_id IS NULL).
WITH RECURSIVE ancestry AS (
  SELECT w.id AS start_id, w.id AS cur_id, w.parent_id AS cur_parent_id
    FROM work_types w
  UNION ALL
  SELECT a.start_id, p.id AS cur_id, p.parent_id AS cur_parent_id
    FROM ancestry a
    JOIN work_types p ON p.id = a.cur_parent_id
)
UPDATE work_types w
SET sbornik_id = a.cur_id
FROM ancestry a
WHERE a.start_id = w.id AND a.cur_parent_id IS NULL;

-- Диагностика: строки, для которых backfill не смог найти корень (реальный
-- цикл в дереве быть не должен — parent_id ссылается на уже существующую
-- строку с ON DELETE SET NULL, — но если он всё же есть, рекурсивный CTE
-- для этой строки просто никогда не достигнет cur_parent_id IS NULL и
-- строка останется без sbornik_id). NOTICE, не EXCEPTION — не блокируем
-- миграцию, но печатаем количество и до 20 id для ручной проверки.
DO $$
DECLARE
  orphan_count INTEGER;
  orphan_ids INTEGER[];
BEGIN
  SELECT count(*) INTO orphan_count FROM work_types WHERE sbornik_id IS NULL;

  IF orphan_count > 0 THEN
    SELECT array_agg(id) INTO orphan_ids
      FROM (SELECT id FROM work_types WHERE sbornik_id IS NULL ORDER BY id LIMIT 20) t;
    RAISE NOTICE 'sbornik_id backfill: % строк(и) остались без sbornik_id, id (до 20): %',
      orphan_count, orphan_ids;
  ELSE
    RAISE NOTICE 'sbornik_id backfill: все строки получили sbornik_id.';
  END IF;
END $$;

-- (c) Обычный (не уникальный) индекс на sbornik_id — для будущих запросов
-- по книге (аналогично idx_work_types_parent_id из миграции 017).
CREATE INDEX IF NOT EXISTS idx_work_types_sbornik_id ON work_types(sbornik_id);

-- (d) Старый глобальный уникальный индекс — снимаем.
DROP INDEX IF EXISTS idx_work_types_gesn_code;

-- Перед созданием нового индекса — явная проверка, что частичный индекс
-- WHERE gesn_code IS NOT NULL корректно исключит все нелистовые узлы:
-- gesn_code во всех текущих путях записи (import-gesn-catalog.js,
-- import-user-catalog.js, import-additional-sborniks.js) для level 2-4 либо
-- не передаётся в INSERT (столбец без DEFAULT — остаётся NULL), либо явно
-- NULL — но не проверялось, что нигде не проскочила пустая строка ''
-- (частичный индекс её НЕ исключает, а два '' в одной книге дали бы
-- падение CREATE UNIQUE INDEX с менее понятной ошибкой). Явно проверяем и
-- останавливаем миграцию понятным сообщением, если такое найдётся.
DO $$
DECLARE
  blank_count INTEGER;
BEGIN
  SELECT count(*) INTO blank_count FROM work_types WHERE gesn_code = '';
  IF blank_count > 0 THEN
    RAISE EXCEPTION 'Найдено % строк(и) с пустым (не NULL) gesn_code — частичный уникальный индекс их не исключит, проверьте и почистите перед повторным запуском миграции', blank_count;
  END IF;
END $$;

-- (e) Новый частичный уникальный индекс — уникальность в пределах сборника.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_types_sbornik_gesn_code
  ON work_types(sbornik_id, gesn_code)
  WHERE gesn_code IS NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('025_scope_gesn_code_uniqueness.sql') ON CONFLICT DO NOTHING;

COMMIT;
