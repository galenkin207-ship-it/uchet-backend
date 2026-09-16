import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../async-handler.js";

// Read-only роутер поверх древовидной структуры work_types (level, parent_id,
// catalog_type — миграция 017/018). Отдельно от workTypesRouter/directories.js —
// тот остаётся плоским CRUD-справочником для админки, этот — для каскадного
// выбора вида работы и полнотекстового поиска по дереву на фронте/мобильном.
export const workTypesTreeRouter = Router();

const TREE_COLUMNS = `
  id, name, level, parent_id, unit, price, has_price, gesn_code, catalog_type,
  is_step_item, step_unit_label, step_base_work_type_id, work_composition,
  labor_hours, variant_label, source
`;

// Тот же паттерн ведущего кода, что и в миграции 023
// (напр. "01-02-088 " или "15-06-001 " перед текстом таблицы/раздела).
const CODE_PREFIX_RE = /^\d{2}(-\d{2,3}){1,2}\s+/;

function stripCodePrefix(name) {
  return String(name ?? "").replace(CODE_PREFIX_RE, "");
}

function normalizeForCompare(name) {
  return String(name ?? "").trim().toLowerCase();
}

// is_step_item=true — шаговые/модификаторные строки (напр. "На каждый
// 1 мм... добавлять к норме"), не самостоятельная позиция для обычного
// каскада — задел под будущий UI счётчика (step-counter), пока не
// реализован. Скрываем их из списка узлов.
//
// Этого недостаточно: родительская группа (level 1-4), у которой ВСЕ
// потомки на всех уровнях ниже — шаговые is_step_item=true листья,
// сама никогда не была самостоятельной позицией (просто контейнер для
// шагового модификатора) и после фильтрации листьев превращается в
// "карточку-призрак" — has_children=false, но и цены нет. leaf_ancestors
// рекурсивно поднимается от каждого настоящего (не-шагового) листа
// уровня 5 вверх по parent_id и собирает всех его предков; ancestors_
// with_real_leaf — множество id узлов, у которых есть хотя бы один
// настоящий лист где-то в поддереве. Такую группу и в общем списке, и в
// подсчёте has_children родителя учитываем наравне с настоящими листьями.
async function fetchChildrenRows(where, params) {
  const { rows } = await pool.query(
    `WITH RECURSIVE leaf_ancestors AS (
       SELECT id AS leaf_id, parent_id AS ancestor_id
         FROM work_types
        WHERE level = 5 AND is_step_item = false AND status <> 'archived'
              AND parent_id IS NOT NULL
       UNION ALL
       SELECT la.leaf_id, wt2.parent_id AS ancestor_id
         FROM leaf_ancestors la
         JOIN work_types wt2 ON wt2.id = la.ancestor_id
        WHERE wt2.parent_id IS NOT NULL
     ),
     ancestors_with_real_leaf AS (
       SELECT DISTINCT ancestor_id AS id FROM leaf_ancestors
     )
     SELECT ${TREE_COLUMNS},
            EXISTS (
              SELECT 1 FROM work_types c
               WHERE c.parent_id = wt.id AND c.status <> 'archived' AND c.is_step_item = false
                 AND (
                   c.level = 5
                   OR EXISTS (SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = c.id)
                 )
            ) AS has_children,
            EXISTS (
              SELECT 1 FROM work_types s
               WHERE s.step_base_work_type_id = wt.id AND s.is_counter_step = true
                 AND s.status <> 'archived'
            ) AS has_counter_steps
       FROM work_types wt
      WHERE ${where} AND wt.status <> 'archived' AND wt.is_step_item = false
        AND (
          wt.level = 5
          OR EXISTS (SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = wt.id)
        )
      ORDER BY wt.sort_order, wt.name`,
    params,
  );
  return rows;
}

// Миграция 023 заполнила ряд групп (level=4) без собственного текста именем
// их родительской таблицы (level=3, код в начале срезан). В каскаде такая
// группа — лишний промежуточный клик с текстом, полностью дублирующим текст
// родителя. Разворачиваем это прозрачно на чтении, без изменения данных:
// если после trim/lower-case и срезания кода у родителя имя ребёнка с ним
// совпадает — не отдаём сам этот узел, а подставляем на его место его
// собственных детей (на том же уровне списка, что и остальные настоящие
// дети родителя). Правило текстовое, а не по id — сработает для любого
// уровня, где возникнет такое же дублирование. Листья (level=5) своих детей
// не имеют, поэтому раскрывать их не пытаемся, и рекурсия по построению
// конечна — дети развёрнутого узла проверяются на дублирование уже
// относительно ЕГО собственного (свежесрезанного) имени.
async function expandDuplicateGroups(parentId, parentNameStripped) {
  const rows = await fetchChildrenRows("wt.parent_id = $1", [parentId]);
  if (!parentNameStripped) return rows;

  const parentNorm = normalizeForCompare(parentNameStripped);
  const result = [];
  for (const row of rows) {
    if (row.level !== 5 && normalizeForCompare(row.name) === parentNorm) {
      const nested = await expandDuplicateGroups(row.id, stripCodePrefix(row.name));
      result.push(...nested);
    } else {
      result.push(row);
    }
  }
  return result;
}

// GET /tree?parentId=<id>&type=<строка>
// Без parentId — корневой уровень одного каталога (type обязателен).
// С parentId — непосредственные дети конкретного узла (каталог уже
// однозначно определён самим узлом, catalog_type не фильтруем).
workTypesTreeRouter.get(
  "/tree",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parentId, type } = req.query;

    if (parentId === undefined || parentId === "") {
      if (!type) {
        return res.status(400).json({ error: "Укажите type или parentId" });
      }
      // Корневой уровень (каталоги) — родителя для сравнения имён нет.
      const rows = await fetchChildrenRows(
        "wt.parent_id IS NULL AND wt.level = 1 AND wt.catalog_type = $1",
        [type],
      );
      return res.json({ items: rows });
    }

    const id = Number(parentId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "parentId должен быть целым числом" });
    }

    const { rows: parentRows } = await pool.query(
      "SELECT name FROM work_types WHERE id = $1",
      [id],
    );
    const parentNameStripped = parentRows[0] ? stripCodePrefix(parentRows[0].name) : null;

    const items = await expandDuplicateGroups(id, parentNameStripped);

    res.json({ items });
  }),
);

// GET /:baseId/counter-steps
// Список независимых шаговых модификаторов (is_counter_step=true) для
// базовой позиции baseId — используется UI счётчика (step-counter): у
// базового листа своя цена (за "стандартный" объём), у каждого шага —
// цена за один инкремент своей единицы (step_unit_label).
workTypesTreeRouter.get(
  "/:baseId/counter-steps",
  requireAuth,
  asyncHandler(async (req, res) => {
    const baseId = Number(req.params.baseId);
    if (!Number.isInteger(baseId)) {
      return res.status(400).json({ error: "baseId должен быть целым числом" });
    }

    const { rows } = await pool.query(
      `SELECT id, gesn_code, step_unit_label, price
         FROM work_types
        WHERE step_base_work_type_id = $1 AND is_counter_step = true AND status <> 'archived'
        ORDER BY sort_order, id`,
      [baseId],
    );

    res.json({ items: rows });
  }),
);

// Та же нормализация/токенизация, что и в client-side smart-search (нет
// общего пакета между фронтом и бэкендом — логика продублирована здесь).
function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .trim();
}

function tokenize(query) {
  return normalize(query).split(/\s+/).filter(Boolean);
}

// /search возвращает листья напрямую, без промежуточных узлов каскада, так
// что сама "лишняя карточка" (см. expandDuplicateGroups выше) тут ни при чём —
// но название дублирующей группы (level=4) всё ещё попадает в breadcrumb как
// отдельное звено, повторяющее текст таблицы перед ним. Тем же текстовым
// правилом убираем из хлебных крошек звено, совпадающее (после срезания
// кода) с предыдущим.
function dedupeBreadcrumb(parts) {
  const result = [];
  for (const part of parts) {
    const prev = result[result.length - 1];
    if (prev != null && normalizeForCompare(stripCodePrefix(prev)) === normalizeForCompare(part)) {
      continue;
    }
    result.push(part);
  }
  return result;
}

// Тот же скоринг, что и matchScore(text, query) во фронтовом smart-search:
// чем раньше во тексте встречается токен и чем ближе к началу слова — тем
// меньше (лучше) итоговый score; длина текста — небольшой tie-breaker в
// пользу более коротких/точных совпадений.
function matchScore(text, tokens) {
  const normText = normalize(text);
  let score = 0;
  for (const token of tokens) {
    const idx = normText.indexOf(token);
    if (idx === -1) continue;
    const isWordStart = idx === 0 || /\s/.test(normText[idx - 1]);
    score += idx + (isWordStart ? 0 : 50);
  }
  score += text.length * 0.05;
  return score;
}

// GET /search?q=<строка>&limit=<число, по умолчанию 50, максимум 200>
// Двухэтапно: SQL сужает кандидатов до level=5 позиций, содержащих все
// токены (верхняя защитная граница LIMIT 500, не финальная выдача), затем
// JS считает тот же score, что и в клиентском smart-search, и сортирует.
workTypesTreeRouter.get(
  "/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rawQuery = req.query.q;
    const tokens = tokenize(rawQuery);
    if (!rawQuery || normalize(rawQuery).length < 2 || tokens.length === 0) {
      return res.json({ items: [] });
    }

    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(Math.trunc(limit), 200);

    const ilikeClauses = tokens.map((_, i) => `wt.name ILIKE $${i + 1}`).join(" AND ");
    const params = tokens.map((t) => `%${t}%`);

    // 4 уровня предков фиксированы деревом (сборник → раздел → таблица →
    // группа) — прямые JOIN проще и понятнее, чем рекурсивный CTE, для
    // фиксированной глубины.
    const { rows } = await pool.query(
      `SELECT wt.id, wt.name, wt.level, wt.parent_id, wt.unit, wt.price, wt.has_price,
              wt.gesn_code, wt.catalog_type, wt.is_step_item, wt.step_unit_label,
              wt.work_composition, wt.labor_hours, wt.source,
              EXISTS (
                SELECT 1 FROM work_types s
                 WHERE s.step_base_work_type_id = wt.id AND s.is_counter_step = true
                   AND s.status <> 'archived'
              ) AS has_counter_steps,
              p1.name AS breadcrumb_1, p2.name AS breadcrumb_2,
              p3.name AS breadcrumb_3, p4.name AS breadcrumb_4
         FROM work_types wt
         LEFT JOIN work_types p4 ON p4.id = wt.parent_id
         LEFT JOIN work_types p3 ON p3.id = p4.parent_id
         LEFT JOIN work_types p2 ON p2.id = p3.parent_id
         LEFT JOIN work_types p1 ON p1.id = p2.parent_id
        WHERE wt.level = 5 AND wt.status <> 'archived' AND wt.is_step_item = false AND ${ilikeClauses}
        ORDER BY wt.id
        LIMIT 500`,
      params,
    );

    const items = rows
      .map((row) => {
        const {
          breadcrumb_1: b1,
          breadcrumb_2: b2,
          breadcrumb_3: b3,
          breadcrumb_4: b4,
          ...item
        } = row;
        return {
          ...item,
          breadcrumb: dedupeBreadcrumb([b1, b2, b3, b4].filter((x) => x != null)),
          score: matchScore(row.name, tokens),
        };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map(({ score, ...item }) => item);

    res.json({ items });
  }),
);
