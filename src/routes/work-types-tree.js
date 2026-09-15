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
  labor_hours, variant_label
`;

// GET /tree?parentId=<id>&type=<строка>
// Без parentId — корневой уровень одного каталога (type обязателен).
// С parentId — непосредственные дети конкретного узла (каталог уже
// однозначно определён самим узлом, catalog_type не фильтруем).
workTypesTreeRouter.get(
  "/tree",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parentId, type } = req.query;

    let where;
    let params;
    if (parentId === undefined || parentId === "") {
      if (!type) {
        return res.status(400).json({ error: "Укажите type или parentId" });
      }
      where = "wt.parent_id IS NULL AND wt.level = 1 AND wt.catalog_type = $1";
      params = [type];
    } else {
      const id = Number(parentId);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "parentId должен быть целым числом" });
      }
      where = "wt.parent_id = $1";
      params = [id];
    }

    // is_step_item=true — шаговые/модификаторные строки (напр. "На каждый
    // 1 мм... добавлять к норме"), не самостоятельная позиция для обычного
    // каскада — задел под будущий UI счётчика (step-counter), пока не
    // реализован. Скрываем их и из списка узлов, и из подсчёта
    // has_children родителя, чтобы карточка родителя с единственным
    // шаговым ребёнком корректно выглядела как лист, а не как узел с
    // пустым списком детей.
    const { rows } = await pool.query(
      `SELECT ${TREE_COLUMNS},
              EXISTS (
                SELECT 1 FROM work_types c
                 WHERE c.parent_id = wt.id AND c.status <> 'archived' AND c.is_step_item = false
              ) AS has_children
         FROM work_types wt
        WHERE ${where} AND wt.status <> 'archived' AND wt.is_step_item = false
        ORDER BY wt.sort_order, wt.name`,
      params,
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
              wt.work_composition, wt.labor_hours,
              p1.name AS breadcrumb_1, p2.name AS breadcrumb_2,
              p3.name AS breadcrumb_3, p4.name AS breadcrumb_4
         FROM work_types wt
         LEFT JOIN work_types p4 ON p4.id = wt.parent_id
         LEFT JOIN work_types p3 ON p3.id = p4.parent_id
         LEFT JOIN work_types p2 ON p2.id = p3.parent_id
         LEFT JOIN work_types p1 ON p1.id = p2.parent_id
        WHERE wt.level = 5 AND wt.status <> 'archived' AND ${ilikeClauses}
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
          breadcrumb: [b1, b2, b3, b4].filter((x) => x != null),
          score: matchScore(row.name, tokens),
        };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map(({ score, ...item }) => item);

    res.json({ items });
  }),
);
