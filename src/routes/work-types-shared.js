// Общие хелперы для каскадного редактирования дерева видов работ (work_types),
// используемые и плоским справочником (directories.js — workTypesRouter), и
// древовидным роутером (work-types-tree.js). Вынесено в отдельный модуль,
// чтобы оба роутера могли переиспользовать логику без циклического импорта
// друг друга.

import { pool } from "../db.js";

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
//
// activeOnly — считать конфликтом только неархивных братьев (batch-создание);
// по умолчанию архивные тоже учитываются, как раньше.
export async function checkNameUniqueAmongSiblings(executor, { parentId, catalogType, name, excludeId, activeOnly = false }) {
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
  if (activeOnly) clauses.push("status <> 'archived'");
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

// Ошибки Postgres при записи в work_types → 400/409 с русским сообщением
// вместо 500: 23502 (NOT NULL) и 23505 (unique). Возвращает { status, error }
// или null, если ошибка не из этого списка — вызывающий пробрасывает err
// дальше как раньше. Специфичные проверки (например,
// idx_work_types_sbornik_gesn_code с текстом про код ГЭСН) вызывающий
// делает ДО этого хелпера.
export function mapWorkTypeDbError(err, { duplicateMessage }) {
  if (err.code === "23502") {
    console.warn(`work_types: NOT NULL violation, column=${err.column}`);
    return { status: 400, error: "Не заполнено обязательное поле" };
  }
  if (err.code === "23505") {
    console.warn(`work_types: unique violation, constraint=${err.constraint}`);
    return { status: 409, error: duplicateMessage };
  }
  return null;
}

// Обёртка над mapWorkTypeDbError для обычных (не транзакционных) обработчиков:
// true, если ошибка обработана и ответ уже отправлен.
export function respondWorkTypeDbError(err, res, opts) {
  const mapped = mapWorkTypeDbError(err, opts);
  if (!mapped) return false;
  res.status(mapped.status).json({ error: mapped.error });
  return true;
}

// ---------------------------------------------------------------------------
// Создание листа (level=5) — общая логика POST /api/work-types (одиночное) и
// POST /api/work-types/batch. Все хелперы возвращают { error: { status, error } }
// вместо отправки ответа, чтобы batch мог откатить транзакцию и дописать номер
// строки к сообщению.
// ---------------------------------------------------------------------------

// Название листа под группой (level 4): группа + вариант в конвенции каталога.
//   - группа уже оканчивается на ":" (ГЭСН: «Трансформатор трехфазный:») →
//     «группа вариант»; иначе (пользовательский прайс) → «группа: вариант»;
//   - пустой вариант → просто название группы;
//   - защита от задвоения: вариант, который (после нормализации: регистр, ё→е,
//     без пунктуации и лишних пробелов) равен названию группы или начинается с
//     него по границе слова, уже содержит группу — берётся как есть.
// Лишние пробелы в группе и варианте схлопываются. Единственное место, где
// сервер собирает имя листа под группой (batch и PATCH /:id/edit).
function normalizeForNameCompare(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildLeafName(groupName, variant) {
  const group = String(groupName ?? "").replace(/\s+/g, " ").trim();
  const v = String(variant ?? "").replace(/\s+/g, " ").trim();
  if (!v) return group;
  if (!group) return v;

  const normGroup = normalizeForNameCompare(group);
  const normVariant = normalizeForNameCompare(v);
  if (normGroup && (normVariant === normGroup || normVariant.startsWith(`${normGroup} `))) {
    return v;
  }
  return group.endsWith(":") ? `${group} ${v}` : `${group}: ${v}`;
}

// Обязательные поля листа: название, единица (NOT NULL в work_types — без неё
// INSERT упал бы с 23502) и цена. Возвращает текст ошибки или null.
export function validateLeafInput({ name, unit, price }) {
  if (!name || !String(name).trim()) return "Укажите название";
  if (unit == null || !String(unit).trim()) return "Укажите единицу измерения";
  return validatePrice(price);
}

// Родитель будущего листа: существует, не архивный, не лист. forUpdate —
// блокировка строки на время транзакции (batch: чтобы параллельные запросы
// не проскочили между проверкой уникальности и вставкой).
export async function loadLeafParent(executor, parentId, { forUpdate = false } = {}) {
  const { rows } = await executor.query(
    `SELECT id, level, name, status, sbornik_id, catalog_type FROM work_types WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [parentId],
  );
  const parent = rows[0];
  if (!parent) return { error: { status: 400, error: "Родительский узел не найден" } };
  if (parent.status === "archived") return { error: { status: 400, error: "Родительский узел архивирован" } };
  if (parent.level >= 5) return { error: { status: 400, error: "Родитель не может быть листом" } };
  return { parent };
}

// Уникальность имени среди братьев и gesn_code в сборнике, затем INSERT листа
// (level=5, source='manual', status='active'). fields.name/variant_label уже
// финальные (name — итоговое имя листа). Возвращает { id } или { error }.
// options.nameConflictMessage — если задан, проверка имени идёт только среди
// неархивных братьев и при конфликте (в т.ч. на уровне БД) отдаётся этот текст
// (batch); без options поведение прежнее (одиночный POST).
export async function insertLeaf(executor, parent, fields, options = {}) {
  const { nameConflictMessage = null } = options;
  const { name, variant_label, unit, price, has_price, labor_hours, gesn_code, work_composition, sort_order } = fields;

  const nameError = await checkNameUniqueAmongSiblings(executor, {
    parentId: parent.id,
    catalogType: parent.catalog_type,
    name,
    excludeId: null,
    activeOnly: nameConflictMessage != null,
  });
  if (nameError) return { error: { status: 409, error: nameConflictMessage ?? nameError } };

  const sbornikId = parent.level === 1 ? parent.id : parent.sbornik_id;
  const trimmedGesnCode = gesn_code != null && String(gesn_code).trim() ? String(gesn_code).trim() : null;

  if (trimmedGesnCode) {
    const gesnError = await checkGesnCodeUnique(executor, sbornikId, trimmedGesnCode, null);
    if (gesnError) return { error: { status: 409, error: gesnError } };
  }

  try {
    const { rows } = await executor.query(
      `INSERT INTO work_types
         (parent_id, level, catalog_type, sbornik_id, name, variant_label, unit, price, has_price,
          labor_hours, gesn_code, work_composition, sort_order, source, status)
       VALUES ($1,5,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual','active')
       RETURNING id`,
      [
        parent.id,
        parent.catalog_type,
        sbornikId,
        String(name).trim(),
        variant_label || null,
        String(unit).trim(),
        price ?? 0,
        has_price !== false,
        labor_hours ?? null,
        trimmedGesnCode,
        work_composition || null,
        sort_order ?? 0,
      ],
    );
    return { id: rows[0].id };
  } catch (err) {
    if (err.code === "23505" && err.constraint === "idx_work_types_sbornik_gesn_code") {
      return { error: { status: 409, error: `Код ГЭСН «${trimmedGesnCode}» уже используется в этом сборнике` } };
    }
    const mapped = mapWorkTypeDbError(err, { duplicateMessage: nameConflictMessage ?? "Такая позиция уже есть" });
    if (mapped) return { error: mapped };
    throw err;
  }
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

// Текст для эмбеддинга листа — тот же, что в scripts/index-embeddings.js.
function buildEmbeddingText(row) {
  return [row.name, row.variant_label, row.work_composition].filter(Boolean).join(". ");
}

// Поля, от которых зависит текст эмбеддинга (для проверки «изменилось ли»).
const EMBEDDING_TEXT_FIELDS = ["name", "variant_label", "work_composition"];

export function embeddingTextChanged(before, after) {
  return EMBEDDING_TEXT_FIELDS.some((f) => (before?.[f] ?? null) !== (after?.[f] ?? null));
}

async function refreshEmbeddings(ids) {
  // Текст берём из БД уже после COMMIT — финальные значения; не-листья и
  // шаговые строки отсекаются здесь же (им эмбеддинг не нужен).
  const { rows } = await pool.query(
    `SELECT id, gesn_code, name, variant_label, work_composition
       FROM work_types
      WHERE id = ANY($1) AND level = 5 AND is_step_item = false`,
    [ids],
  );
  if (!rows.length) return;
  // Ленивый импорт: new OpenAI() в openai.js бросает без OPENAI_API_KEY, а этот
  // модуль импортируют и офлайн-скрипты (scripts/test-build-leaf-name.js).
  const { getEmbedding } = await import("../openai.js");
  for (const row of rows) {
    try {
      const vector = await getEmbedding(buildEmbeddingText(row));
      await pool.query(`UPDATE work_types SET embedding = $1 WHERE id = $2`, [JSON.stringify(vector), row.id]);
    } catch (err) {
      console.error(`Не удалось пересчитать эмбеддинг work_types id=${row.id} gesn_code=${row.gesn_code ?? "-"}:`, err.message);
    }
  }
}

// Фоновый пересчёт эмбеддинга (для /search-smart) после создания/правки
// листа. Вызывать ПОСЛЕ отправки ответа: не ждём, ошибки только в лог —
// на запрос и процесс сбой OpenAI/UPDATE не влияет.
export function scheduleEmbeddingRefresh(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) return;
  setImmediate(() => {
    refreshEmbeddings(list).catch((err) => {
      console.error(`Не удалось пересчитать эмбеддинги work_types ids=${list.join(",")}:`, err.message);
    });
  });
}
