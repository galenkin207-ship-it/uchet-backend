// Общие хелперы для каскадного редактирования дерева видов работ (work_types),
// используемые и плоским справочником (directories.js — workTypesRouter), и
// древовидным роутером (work-types-tree.js). Вынесено в отдельный модуль,
// чтобы оба роутера могли переиспользовать логику без циклического импорта
// друг друга.

export function validatePrice(price) {
  if (price == null) return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return "Цена должна быть неотрицательным числом";
  return null;
}

// Каскадный пересчёт: название/единица/цена вида работы всегда должны
// совпадать с тем, что показано во всех записях, где он использован — в т.ч.
// уже завершённых (done). См. подробный комментарий в исходном месте
// (directories.js, история до выноса в общий модуль).
export async function cascadeWorkTypeUpdate(client, updated) {
  await client.query(
    `UPDATE record_items
        SET name = $1, unit = $2, price = $3, sum = qty * $3
      WHERE work_type_id = $4`,
    [updated.name, updated.unit, updated.price, updated.id],
  );
  await client.query(
    `UPDATE records r
        SET total = sub.total
       FROM (
         SELECT record_id, COALESCE(SUM(sum), 0) AS total
         FROM record_items
         WHERE record_id IN (SELECT DISTINCT record_id FROM record_items WHERE work_type_id = $1)
         GROUP BY record_id
       ) sub
      WHERE r.id = sub.record_id`,
    [updated.id],
  );
}

// Уникальность имени среди детей одного родителя (parentId) — для узлов
// level 1 (parentId === null), у которых общий NULL parent_id на все каталоги
// сразу, дополнительно скопировано по catalogType, иначе "Раздел А" в каталоге
// ГЭСН конфликтовал бы с "Раздел А" в другом каталоге.
export async function checkNameUniqueAmongSiblings(executor, { parentId, catalogType, name, excludeId }) {
  if (!name || !String(name).trim()) return null;
  const clauses = ["lower(btrim(name)) = lower(btrim($1))"];
  const params = [name];
  if (parentId == null) {
    clauses.push("parent_id IS NULL");
    params.push(catalogType);
    clauses.push(`catalog_type = $${params.length}`);
  } else {
    params.push(parentId);
    clauses.push(`parent_id = $${params.length}`);
  }
  if (excludeId != null) {
    params.push(excludeId);
    clauses.push(`id <> $${params.length}`);
  }
  const { rows } = await executor.query(
    `SELECT id FROM work_types WHERE ${clauses.join(" AND ")}`,
    params,
  );
  if (rows.length) {
    return `«${String(name).trim()}» уже есть среди дочерних узлов этого раздела`;
  }
  return null;
}

// Уникальность gesn_code в пределах сборника (sbornik_id) — отражает
// частичный уникальный индекс idx_work_types_sbornik_gesn_code (миграция 025).
export async function checkGesnCodeUnique(executor, sbornikId, gesnCode, excludeId) {
  if (!gesnCode) return null;
  const params = [sbornikId, gesnCode];
  let excludeClause = "";
  if (excludeId != null) {
    params.push(excludeId);
    excludeClause = ` AND id <> $${params.length}`;
  }
  const { rows } = await executor.query(
    `SELECT id FROM work_types WHERE sbornik_id IS NOT DISTINCT FROM $1 AND gesn_code = $2${excludeClause}`,
    params,
  );
  if (rows.length) {
    return `Код ГЭСН «${gesnCode}» уже используется в этом сборнике`;
  }
  return null;
}

// Цепочка предков листа от корня (level 1) вниз, не включая сам лист.
export async function getAncestorChain(executor, leafId) {
  const { rows } = await executor.query(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id, level, name, catalog_type
         FROM work_types
        WHERE id = (SELECT parent_id FROM work_types WHERE id = $1)
       UNION ALL
       SELECT wt.id, wt.parent_id, wt.level, wt.name, wt.catalog_type
         FROM work_types wt
         JOIN anc ON wt.id = anc.parent_id
     )
     SELECT id, level, name, catalog_type FROM anc ORDER BY level ASC`,
    [leafId],
  );
  return rows;
}

const LEAF_DETAIL_COLUMNS = `
  id, parent_id, level, catalog_type, gesn_code, labor_hours, work_composition,
  variant_label, name, unit, price, has_price, sbornik_id, source, sort_order, status,
  is_step_item, is_counter_step, step_base_work_type_id, step_unit_label
`;

// Лист целиком (все редактируемые + служебные поля) + цепочка предков +
// placeholder materials — общий формат для GET /:id/detail, PATCH /:id/edit
// и POST /api/work-types (создание листа).
export async function buildLeafDetail(executor, id) {
  const { rows } = await executor.query(
    `SELECT ${LEAF_DETAIL_COLUMNS} FROM work_types WHERE id = $1`,
    [id],
  );
  const leaf = rows[0];
  if (!leaf) return null;
  const ancestors = await getAncestorChain(executor, id);
  return { ...leaf, ancestors, materials: [] };
}

// Архивация строки work_types (лист ИЛИ контейнер). Для контейнера (level<5)
// запрещает архивацию, пока внутри (на любой глубине поддерева) остаются
// неархивные листья — иначе они молча "пропадают" из каскада (родителя не
// найти через /tree), хотя сами формально всё ещё активны. Общая для
// directories.js (PATCH /:id/archive — леф+контейнер, как было) и
// work-types-tree.js (PATCH /nodes/:id/archive — только контейнер).
export async function archiveWorkType(executor, id) {
  const { rows: beforeRows } = await executor.query(
    `SELECT id, name, unit, price, status, archived_at, level FROM work_types WHERE id = $1`,
    [id],
  );
  const before = beforeRows[0];
  if (!before) return { notFound: true };

  if (before.level < 5) {
    const { rows: activeLeafRows } = await executor.query(
      `WITH RECURSIVE sub AS (
         SELECT id FROM work_types WHERE id = $1
         UNION ALL
         SELECT wt.id FROM work_types wt JOIN sub ON wt.parent_id = sub.id
       )
       SELECT 1 FROM work_types
        WHERE id IN (SELECT id FROM sub) AND id <> $1 AND level = 5 AND status <> 'archived'
        LIMIT 1`,
      [id],
    );
    if (activeLeafRows.length) {
      return {
        conflict: "Внутри раздела есть неархивные виды работ — сначала заархивируйте их",
        before,
      };
    }
  }

  const { rows } = await executor.query(
    `UPDATE work_types SET status = 'archived', archived_at = now()
     WHERE id = $1
     RETURNING id, name, unit, price, status, archived_at`,
    [id],
  );
  return { before, after: rows[0] };
}
