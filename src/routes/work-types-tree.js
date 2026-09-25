import { Router } from "express";
import { pool } from "../db.js";
import { getEmbedding } from "../openai.js";
import { rerankCandidates } from "../deepseek.js";
import { requireAuth, requireRole, isAdminLike } from "../auth.js";
import { asyncHandler } from "../async-handler.js";
import { insertAuditLog } from "../audit.js";
import {
  validatePrice,
  cascadeWorkTypeUpdate,
  checkNameUniqueAmongSiblings,
  checkGesnCodeUnique,
  buildLeafDetail,
  archiveWorkType,
  respondWorkTypeDbError,
  validateLeafInput,
  loadLeafParent,
  insertLeaf,
  buildLeafName,
  embeddingTextChanged,
  scheduleEmbeddingRefresh,
} from "./work-types-shared.js";

// Роутер поверх древовидной структуры work_types (level, parent_id,
// catalog_type — миграция 017/018). Отдельно от workTypesRouter/directories.js —
// тот остаётся плоским CRUD-справочником для админки (простые виды работ без
// дерева), этот — каскадный выбор вида работы и полнотекстовый поиск по дереву
// на фронте/мобильном (GET /tree, /search, /:baseId/counter-steps — любой
// авторизованный), плюс каскадное редактирование самого дерева (GET .../detail —
// admin/curator; PATCH .../edit правки существующей позиции — только admin;
// остальные POST/PATCH .../nodes — см. requireRole на каждом хендлере).
export const workTypesTreeRouter = Router();

// /search-smart: если лучший similarity ступени A ниже порога — включается
// ступень B (реранк топ-кандидатов через DeepSeek).
const SEARCH_SMART_RERANK_THRESHOLD = 0.5;
const SEARCH_SMART_RERANK_CANDIDATES = 20;

const TREE_COLUMNS = `
  id, name, level, parent_id, unit, price, has_price, gesn_code, catalog_type,
  is_step_item, step_unit_label, step_base_work_type_id, work_composition,
  labor_hours, variant_label, source
`;

// Колонки листа для only_leaf: формат узла /tree плюс is_counter_step.
const ONLY_LEAF_COLUMNS = `
  c.id, c.name, c.level, c.parent_id, c.unit, c.price, c.has_price, c.gesn_code, c.catalog_type,
  c.is_step_item, c.is_counter_step, c.step_unit_label, c.step_base_work_type_id,
  c.work_composition, c.labor_hours, c.variant_label, c.source
`;

// only_leaf для групп (level=4) в списке узлов: единственный неархивный
// нешаговый ребёнок-лист (level=5) отдаётся прямо в узле группы, чтобы клиент
// сразу показал карточку позиции, а не стрелку, которая схлопывается после
// загрузки детей. «Нешаговый» — как в has_children/списке детей: шаговые строки
// клиент не видит. Один запрос на весь список (GROUP BY parent_id HAVING
// count(*)=1), не по запросу на группу. У остальных групп only_leaf = null;
// у узлов другого level поля нет. Формат — узел листа /tree (без can_edit —
// его добавляет annotateTreeItem).
async function attachOnlyLeaf(rows) {
  const groupIds = rows.filter((r) => r.level === 4).map((r) => r.id);
  if (!groupIds.length) return rows;

  const { rows: leafRows } = await pool.query(
    `SELECT ${ONLY_LEAF_COLUMNS},
            EXISTS (
              SELECT 1 FROM work_types s
               WHERE s.step_base_work_type_id = c.id AND s.is_counter_step = true
                 AND s.status <> 'archived'
            ) AS has_counter_steps
       FROM work_types c
       JOIN (
         SELECT parent_id
           FROM work_types
          WHERE parent_id = ANY($1) AND status <> 'archived' AND is_step_item = false
          GROUP BY parent_id
         HAVING count(*) = 1
       ) solo ON solo.parent_id = c.parent_id
      WHERE c.status <> 'archived' AND c.is_step_item = false AND c.level = 5`,
    [groupIds],
  );
  const byParent = new Map(
    leafRows.map((l) => [l.parent_id, { ...l, has_children: false }]),
  );
  return rows.map((r) => (r.level === 4 ? { ...r, only_leaf: byParent.get(r.id) ?? null } : r));
}

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
//
// includeEmpty (только admin, см. GET /tree) — режим редактирования структуры:
// контейнеры (level<5) без единого настоящего листа в поддереве НЕ скрываются,
// а отдаются с is_empty=true; has_children считается по любым видимым
// неархивным не-шаговым детям (листья или контейнеры, в том числе пустые).
// Исключение — контейнер-модификатор: в поддереве есть шаговые листья, но нет
// ни одного настоящего (напр. группа «Добавлять или исключать на каждые 5 мм»).
// Он скрыт и здесь, как в пикере: это не пустая заготовка под новые позиции,
// а служебная обёртка шаговых строк (ancestors_with_step_leaf).
// containersOnly — только контейнеры (level<5), для селекторов «Расположение».
// level — только узлы с этим level (level — тип узла, не глубина: группа
// level=4 может лежать прямо под сборником).
async function fetchChildrenRows(where, params, { includeEmpty = false, containersOnly = false, level = null } = {}) {
  const hasChildrenCond = includeEmpty
    ? `(
                   c.level = 5
                   OR EXISTS (SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = c.id)
                   OR NOT EXISTS (SELECT 1 FROM ancestors_with_step_leaf a WHERE a.id = c.id)
                 )`
    : `(
                   c.level = 5
                   OR EXISTS (SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = c.id)
                 )`;
  const visibleCond = includeEmpty
    ? `(
          wt.level = 5
          OR EXISTS (SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = wt.id)
          OR NOT EXISTS (SELECT 1 FROM ancestors_with_step_leaf a WHERE a.id = wt.id)
        )`
    : `(
          wt.level = 5
          OR EXISTS (SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = wt.id)
        )`;
  // Предки шаговых листьев — нужны только в режиме includeEmpty (см. выше).
  const stepLeafCte = includeEmpty
    ? `,
     step_leaf_ancestors AS (
       SELECT id AS leaf_id, parent_id AS ancestor_id
         FROM work_types
        WHERE level = 5 AND is_step_item = true AND status <> 'archived'
              AND parent_id IS NOT NULL
       UNION ALL
       SELECT sla.leaf_id, wt3.parent_id AS ancestor_id
         FROM step_leaf_ancestors sla
         JOIN work_types wt3 ON wt3.id = sla.ancestor_id
        WHERE wt3.parent_id IS NOT NULL
     ),
     ancestors_with_step_leaf AS (
       SELECT DISTINCT ancestor_id AS id FROM step_leaf_ancestors
     )`
    : "";
  // is_empty — только в режиме includeEmpty и только у контейнеров: настоящего
  // (не шагового) листа нет нигде в поддереве.
  const isEmptyCol = includeEmpty
    ? `
            (wt.level < 5 AND NOT EXISTS (
              SELECT 1 FROM ancestors_with_real_leaf a WHERE a.id = wt.id
            )) AS is_empty,`
    : "";
  const containersCond = containersOnly ? ` AND wt.level < 5` : "";
  const queryParams = level == null ? params : [...params, level];
  const levelCond = level == null ? "" : ` AND wt.level = $${queryParams.length}`;
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
     )${stepLeafCte}
     SELECT ${TREE_COLUMNS},${isEmptyCol}
            EXISTS (
              SELECT 1 FROM work_types c
               WHERE c.parent_id = wt.id AND c.status <> 'archived' AND c.is_step_item = false
                 AND ${hasChildrenCond}
            ) AS has_children,
            EXISTS (
              SELECT 1 FROM work_types s
               WHERE s.step_base_work_type_id = wt.id AND s.is_counter_step = true
                 AND s.status <> 'archived'
            ) AS has_counter_steps
       FROM work_types wt
      WHERE ${where} AND wt.status <> 'archived' AND wt.is_step_item = false
        AND ${visibleCond}${containersCond}${levelCond}
      ORDER BY wt.sort_order, wt.name`,
    queryParams,
  );
  // only_leaf — только в обычном режиме пикера; справочник (include_empty,
  // containers_only, level) получает узлы как раньше.
  if (!includeEmpty && !containersOnly && level == null) return attachOnlyLeaf(rows);
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

// GET /tree?parentId=<id>&type=<строка>[&include_empty=1][&containers_only=1]
// Без parentId — корневой уровень одного каталога (type обязателен).
// С parentId — непосредственные дети конкретного узла (каталог уже
// однозначно определён самим узлом, catalog_type не фильтруем).
//
// include_empty=1 — режим редактирования структуры, учитывается ТОЛЬКО для
// role === 'admin' (для остальных ролей параметр молча игнорируется):
// отдаёт и пустые контейнеры (level<5 без единого живого листа в поддереве)
// с is_empty=true, has_children — по любым неархивным детям, а
// expandDuplicateGroups не применяется (админ видит реальные узлы).
// containers_only=1 — только контейнеры (level<5), для селекторов «Расположение».
// level=<1..5> — только прямые дети с этим level (тип узла, не глубина); как и
// include_empty/containers_only, отдаёт реальные узлы без схлопывания
// одноимённых групп. Для корня (parentId не задан) level≠1 даёт пустой список.
// Без параметров поведение прежнее (пикер записи, мобильная версия).
workTypesTreeRouter.get(
  "/tree",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parentId, type } = req.query;
    const isTruthyFlag = (v) => v === "1" || v === "true";
    const includeEmpty = isTruthyFlag(req.query.include_empty) && req.user?.role === "admin";
    const containersOnly = isTruthyFlag(req.query.containers_only);
    let level = null;
    if (req.query.level !== undefined && req.query.level !== "") {
      level = Number(req.query.level);
      if (!Number.isInteger(level) || level < 1 || level > 5) {
        return res.status(400).json({ error: "level должен быть целым числом от 1 до 5" });
      }
    }
    const treeOpts = { includeEmpty, containersOnly, level };

    if (parentId === undefined || parentId === "") {
      if (!type) {
        return res.status(400).json({ error: "Укажите type или parentId" });
      }
      // Корневой уровень (каталоги) — родителя для сравнения имён нет.
      const rows = await fetchChildrenRows(
        "wt.parent_id IS NULL AND wt.level = 1 AND wt.catalog_type = $1",
        [type],
        treeOpts,
      );
      return res.json({ items: rows.map((r) => annotateTreeItem(r, req.user)) });
    }

    const id = Number(parentId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "parentId должен быть целым числом" });
    }

    if (includeEmpty || containersOnly || level != null) {
      // Реальные узлы без схлопывания одноимённых групп (только для явно
      // запрошенных режимов; дефолтный путь ниже не меняется).
      const rows = await fetchChildrenRows("wt.parent_id = $1", [id], treeOpts);
      return res.json({ items: rows.map((r) => annotateTreeItem(r, req.user)) });
    }

    const { rows: parentRows } = await pool.query(
      "SELECT name FROM work_types WHERE id = $1",
      [id],
    );
    const parentNameStripped = parentRows[0] ? stripCodePrefix(parentRows[0].name) : null;

    const items = await expandDuplicateGroups(id, parentNameStripped);

    res.json({ items: items.map((r) => annotateTreeItem(r, req.user)) });
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

// can_edit — как и раньше, для листьев (level=5): любой admin/curator.
// can_edit_node — только для контейнеров (level<5) и только для admin:
// POST/PATCH /nodes и archive контейнера теперь admin-only (curator — 403),
// в отличие от операций над листьями.
function annotateTreeItem(row, user) {
  const item = { ...row, can_edit: isAdminLike(user) };
  if (row.only_leaf) item.only_leaf = { ...row.only_leaf, can_edit: isAdminLike(user) };
  if (row.level < 5) {
    item.can_edit_node = !!user && user.role === "admin";
  }
  return item;
}

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

// Токен, похожий на код ГЭСН: "08-06", "08-06-001", "08-06-001-01" (допускаем
// частичный ввод — поиск по префиксу gesn_code).
const GESN_CODE_TOKEN_RE = /^\d{2}(-\d{1,3}){1,3}$/;

// Разбор запроса для /search. Длинные тире → "-", пробелы вокруг дефиса между
// цифрами убираются ("08 - 06 - 001" → "08-06-001"). Если в запросе нашёлся
// токен-код — используем нормализованные токены и отдаём codeToken; иначе
// токенизация прежняя (tokenize), чтобы чисто текстовый поиск не менялся.
function parseSearchQuery(rawQuery) {
  const codeNormalized = normalize(rawQuery)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/(?<=\d)\s*-\s*(?=\d)/g, "-");
  const codeTokens = codeNormalized.split(/\s+/).filter(Boolean);
  const codeToken = codeTokens.find((t) => GESN_CODE_TOKEN_RE.test(t)) ?? null;
  if (codeToken) return { tokens: codeTokens, codeToken };
  return { tokens: tokenize(rawQuery), codeToken: null };
}

// Бонус к score точного совпадения gesn_code в режиме "код + слова" (score:
// чем меньше — тем выше в выдаче; типичный score текста — десятки-сотни).
const EXACT_CODE_SCORE_BONUS = 10000;

// GET /search?q=<строка>&limit=<число, по умолчанию 50, максимум 200>
// Двухэтапно: SQL сужает кандидатов до level=5 позиций, содержащих все
// токены (верхняя защитная граница LIMIT 500, не финальная выдача), затем
// JS считает тот же score, что и в клиентском smart-search, и сортирует.
//
// Поиск по коду ГЭСН: токен-код (см. GESN_CODE_TOKEN_RE) матчится либо по
// префиксу gesn_code, либо по тексту name (OR внутри токена, AND между
// токенами). Чтобы LIMIT 500 не отрезал совпадения по коду, SQL сортирует
// code_tier (0 — точное, 1 — префикс, 2 — только текст) перед LIMIT.
//  - Запрос из одного кода: выдача = точные → префиксные (по gesn_code) →
//    текстовые (по score).
//  - Код + слова: единая сортировка по score, у точного совпадения кода бонус.
// Один код может быть в нескольких сборниках — возвращаем все листья.
workTypesTreeRouter.get(
  "/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rawQuery = req.query.q;
    const { tokens, codeToken } = parseSearchQuery(rawQuery);
    if (!rawQuery || normalize(rawQuery).length < 2 || tokens.length === 0) {
      return res.json({ items: [] });
    }
    const codeOnly = codeToken != null && tokens.length === 1;

    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(Math.trunc(limit), 200);

    const params = tokens.map((t) => `%${t}%`);
    let codeTierSelect = "2 AS code_tier";
    let orderBy = "wt.id";
    let codeClauseFor = null;
    if (codeToken) {
      params.push(codeToken, `${codeToken}%`);
      const exactParam = `$${params.length - 1}`;
      const prefixParam = `$${params.length}`;
      codeTierSelect = `CASE WHEN wt.gesn_code ILIKE ${exactParam} THEN 0
                             WHEN wt.gesn_code ILIKE ${prefixParam} THEN 1
                             ELSE 2 END AS code_tier`;
      orderBy = "code_tier, CASE WHEN wt.gesn_code ILIKE " + prefixParam +
        " THEN wt.gesn_code END, wt.id";
      codeClauseFor = (i) =>
        tokens[i] === codeToken
          ? `(wt.name ILIKE $${i + 1} OR wt.gesn_code ILIKE ${prefixParam})`
          : null;
    }
    const ilikeClauses = tokens
      .map((_, i) => (codeClauseFor && codeClauseFor(i)) || `wt.name ILIKE $${i + 1}`)
      .join(" AND ");

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
              p3.name AS breadcrumb_3, p4.name AS breadcrumb_4,
              ${codeTierSelect}
         FROM work_types wt
         LEFT JOIN work_types p4 ON p4.id = wt.parent_id
         LEFT JOIN work_types p3 ON p3.id = p4.parent_id
         LEFT JOIN work_types p2 ON p2.id = p3.parent_id
         LEFT JOIN work_types p1 ON p1.id = p2.parent_id
        WHERE wt.level = 5 AND wt.status <> 'archived' AND wt.is_step_item = false AND ${ilikeClauses}
        ORDER BY ${orderBy}
        LIMIT 500`,
      params,
    );

    // Array.prototype.sort стабилен: в режиме "только код" порядок точных и
    // префиксных совпадений (gesn_code, id) остаётся таким, как отдал SQL.
    const items = rows
      .map((row) => {
        const {
          breadcrumb_1: b1,
          breadcrumb_2: b2,
          breadcrumb_3: b3,
          breadcrumb_4: b4,
          code_tier: codeTier,
          ...item
        } = row;
        let score = matchScore(row.name, tokens);
        if (!codeOnly && codeTier === 0) score -= EXACT_CODE_SCORE_BONUS;
        return {
          ...item,
          breadcrumb: dedupeBreadcrumb([b1, b2, b3, b4].filter((x) => x != null)),
          tier: codeOnly ? codeTier : 2,
          score,
        };
      })
      .sort((a, b) => a.tier - b.tier || (a.tier === 2 ? a.score - b.score : 0))
      .slice(0, limit)
      .map(({ score, tier, ...item }) => item);

    res.json({ items });
  }),
);

// ---------------------------------------------------------------------------
// GET /search-smart?q=<строка> — семантический поиск через эмбеддинги (ступень A).
// Запрос превращается в вектор (OpenAI text-embedding-3-small) и сравнивается
// с embedding каждой листовой позиции по косинусной близости (оператор <=>,
// использует HNSW-индекс work_types_embedding_hnsw_idx). Возвращает те же поля,
// что и обычный /search, плюс similarity вместо score (чем больше — тем ближе).
// Ступень B: если лучший similarity < SEARCH_SMART_RERANK_THRESHOLD, топ-20
// кандидатов реранкаются через DeepSeek (src/deepseek.js) — items получают
// relevance, в ответе reranked: true. При ошибке реранка — порядок ступени A.
workTypesTreeRouter.get(
  "/search-smart",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rawQuery = req.query.q;
    if (!rawQuery || String(rawQuery).trim().length < 2) {
      return res.json({ items: [] });
    }

    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    limit = Math.min(Math.trunc(limit), 50);

    const query = String(rawQuery).trim();
    const queryEmbedding = await getEmbedding(query);
    const vectorLiteral = JSON.stringify(queryEmbedding);

    const { rows } = await pool.query(
      `SELECT wt.id, wt.name, wt.level, wt.parent_id, wt.unit, wt.price, wt.has_price,
              wt.gesn_code, wt.catalog_type, wt.is_step_item, wt.step_unit_label,
              wt.work_composition, wt.labor_hours, wt.source, wt.variant_label,
              EXISTS (
                SELECT 1 FROM work_types s
                WHERE s.step_base_work_type_id = wt.id AND s.is_counter_step = true
                  AND s.status <> 'archived'
              ) AS has_counter_steps,
              p1.name AS breadcrumb_1, p2.name AS breadcrumb_2,
              p3.name AS breadcrumb_3, p4.name AS breadcrumb_4,
              1 - (wt.embedding <=> $1) AS similarity
       FROM work_types wt
       LEFT JOIN work_types p4 ON p4.id = wt.parent_id
       LEFT JOIN work_types p3 ON p3.id = p4.parent_id
       LEFT JOIN work_types p2 ON p2.id = p3.parent_id
       LEFT JOIN work_types p1 ON p1.id = p2.parent_id
       WHERE wt.level = 5 AND wt.status <> 'archived' AND wt.is_step_item = false
         AND wt.embedding IS NOT NULL
       ORDER BY wt.embedding <=> $1
       LIMIT $2`,
      // Минимум топ-20 — чтобы ступени B было из чего реранкать.
      [vectorLiteral, Math.max(limit, SEARCH_SMART_RERANK_CANDIDATES)]
    );

    const items = rows.map((row) => {
      const { breadcrumb_1: b1, breadcrumb_2: b2, breadcrumb_3: b3, breadcrumb_4: b4, similarity, ...item } = row;
      return {
        ...item,
        breadcrumb: dedupeBreadcrumb([b1, b2, b3, b4].filter((x) => x != null)),
        similarity: Number(similarity),
      };
    });

    // Ступень B: реранк через DeepSeek, только если ступень A не уверена.
    if (items.length > 0 && items[0].similarity < SEARCH_SMART_RERANK_THRESHOLD) {
      const candidates = items.slice(0, SEARCH_SMART_RERANK_CANDIDATES);
      const relevance = await rerankCandidates(query, candidates);
      if (relevance) {
        // Кандидаты без оценки от модели — в конец, в исходном порядке similarity.
        const reranked = candidates
          .map((item) => ({ ...item, relevance: relevance.get(Number(item.id)) ?? null }))
          .sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1));
        const rest = items.slice(SEARCH_SMART_RERANK_CANDIDATES);
        return res.json({ items: [...reranked, ...rest].slice(0, limit), reranked: true });
      }
      console.error(
        `[search-smart] реранк не удался (top similarity=${items[0].similarity.toFixed(3)}), ` +
          "отдаём порядок ступени A"
      );
    }

    res.json({ items: items.slice(0, limit), reranked: false });
  }),
);

// Каскадное редактирование дерева (только admin/curator).
// ---------------------------------------------------------------------------

// GET /:id/detail — лист (level=5) целиком: все редактируемые + служебные
// поля, цепочка предков от корня вниз (реальные узлы, БЕЗ схлопывания
// дублирующих групп — см. expandDuplicateGroups выше, фронт схлопывает сам
// при отображении breadcrumb) и placeholder materials (данных пока нет).
workTypesTreeRouter.get(
  "/:id/detail",
  requireRole("admin", "curator"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }
    const detail = await buildLeafDetail(pool, id);
    if (!detail) return res.status(404).json({ error: "not found" });
    if (detail.level !== 5) {
      return res.status(400).json({ error: "Узел не является листом" });
    }
    res.json(detail);
  }),
);

// Предки узла от сборника (level 1) вниз до непосредственного родителя, без
// самого узла и без синтетического корня source='legacy_root'; пропущенные
// уровни просто отсутствуют. UNION (а не UNION ALL) — страховка от зацикленного
// parent_id. Общая для GET /:id/path и GET /:id/details.
async function loadAncestorChain(id) {
  const { rows } = await pool.query(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id, level, name, gesn_code, catalog_type, source
         FROM work_types
        WHERE id = (SELECT parent_id FROM work_types WHERE id = $1)
       UNION
       SELECT wt.id, wt.parent_id, wt.level, wt.name, wt.gesn_code, wt.catalog_type, wt.source
         FROM work_types wt
         JOIN anc ON wt.id = anc.parent_id
     )
     SELECT id, level, name, gesn_code, catalog_type FROM anc
      WHERE source IS DISTINCT FROM 'legacy_root'
      ORDER BY level ASC`,
    [id],
  );
  return rows;
}

// GET /:id/path — путь позиции в справочнике (для текстового сообщения мастеру
// при одобрении заявки): предки от сборника (level 1) вниз до непосредственного
// родителя + сама позиция. Синтетический корень source='legacy_root' в путь не
// входит; пропущенные уровни (у пользовательских позиций их может не быть)
// просто отсутствуют. Цену не отдаём. catalog_type — у level-1 предка; если
// его нет (позиция под legacy_root), берём catalog_type самой позиции.
// UNION (а не UNION ALL) — страховка от зацикленного parent_id.
workTypesTreeRouter.get(
  "/:id/path",
  requireRole("admin", "curator"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }
    const { rows: leafRows } = await pool.query(
      `SELECT id, name, catalog_type FROM work_types WHERE id = $1`,
      [id],
    );
    const leaf = leafRows[0];
    if (!leaf) return res.status(404).json({ error: "not found" });

    const ancestors = await loadAncestorChain(id);

    const sbornik = ancestors.find((a) => a.level === 1);
    res.json({
      catalog_type: sbornik?.catalog_type ?? leaf.catalog_type ?? null,
      levels: ancestors.map(({ id: nodeId, level, name, gesn_code }) => ({
        id: nodeId,
        level,
        name,
        gesn_code,
      })),
      leaf: { id: leaf.id, name: leaf.name },
    });
  }),
);

// GET /:id/details — «Сведения о позиции» для модалки справочника (admin/curator,
// как и /:id/path). Поля позиции как есть (work_composition — строка/null, пустое
// не выдумываем) + path: цепочка предков от сборника до непосредственного
// родителя БЕЗ самой позиции (та же цепочка, что в /:id/path). catalog_type —
// позиции, а если он null, то сборника (предок level=1).
workTypesTreeRouter.get(
  "/:id/details",
  requireRole("admin", "curator"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }
    const { rows } = await pool.query(
      `SELECT id, name, variant_label, gesn_code, source, catalog_type,
              unit, price, has_price, labor_hours, work_composition
         FROM work_types WHERE id = $1`,
      [id],
    );
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "not found" });

    const ancestors = await loadAncestorChain(id);
    // Если у самой позиции catalog_type не задан — берём его у сборника (level 1).
    const sbornik = ancestors.find((a) => a.level === 1);
    res.json({
      ...item,
      catalog_type: item.catalog_type ?? sbornik?.catalog_type ?? null,
      path: ancestors.map(({ id: nodeId, level, name, gesn_code }) => ({
        id: nodeId,
        level,
        name,
        gesn_code,
      })),
    });
  }),
);

// name и variant_label здесь нет: их считает сам обработчик (см. nameFields в
// PATCH /:id/edit) по типу родителя.
const LEAF_EDITABLE_FIELDS = [
  "unit",
  "price",
  "has_price",
  "labor_hours",
  "gesn_code",
  "work_composition",
  "sort_order",
];

// PATCH /:id/edit — изменение листа (level=5): поля из LEAF_EDITABLE_FIELDS
// плюс необязательная смена родителя (parent_id). level листа не меняется
// никогда (лист всегда level=5) — при смене parent_id пересчитывается только
// sbornik_id по новому родителю. name/variant_label считаются по типу родителя
// (группа level 4 → buildLeafName, только при смене варианта/родителя). Транзакция: строка блокируется FOR UPDATE,
// после UPDATE — тот же каскад в record_items/records, что и у обычного
// справочника (cascadeWorkTypeUpdate), и audit_log — всё атомарно.
workTypesTreeRouter.patch(
  "/:id/edit",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }
    const body = req.body || {};

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: currentRows } = await client.query(
        `SELECT * FROM work_types WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = currentRows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "not found" });
      }
      if (current.level !== 5) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Узел не является листом" });
      }

      if ("price" in body) {
        const priceError = validatePrice(body.price);
        if (priceError) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: priceError });
        }
      }
      // unit/price/has_price/sort_order — NOT NULL: явный null в теле иначе
      // дошёл бы до UPDATE и упал бы с 23502 (validatePrice(null) пропускает).
      if ("unit" in body && (body.unit == null || !String(body.unit).trim())) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Укажите единицу измерения" });
      }
      for (const field of ["price", "has_price", "sort_order"]) {
        if (field in body && body[field] == null) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Не заполнено обязательное поле" });
        }
      }

      let newParentId = current.parent_id;
      let newSbornikId = current.sbornik_id;
      let newCatalogType = current.catalog_type;
      let newParentRow = null;
      const parentChanged = "parent_id" in body && Number(body.parent_id) !== current.parent_id;

      if (parentChanged) {
        const parentId = Number(body.parent_id);
        if (!Number.isInteger(parentId)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "parent_id должен быть целым числом" });
        }
        const { rows: parentRows } = await client.query(
          `SELECT id, level, name, status, sbornik_id, catalog_type FROM work_types WHERE id = $1`,
          [parentId],
        );
        const parent = parentRows[0];
        if (!parent) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Родительский узел не найден" });
        }
        if (parent.status === "archived") {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Родительский узел архивирован" });
        }
        if (parent.level >= 5) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Родитель не может быть листом" });
        }
        newParentId = parent.id;
        newSbornikId = parent.level === 1 ? parent.id : parent.sbornik_id;
        newCatalogType = parent.catalog_type;
        newParentRow = parent;
      } else if (current.parent_id != null) {
        const { rows: parentRows } = await client.query(
          `SELECT id, level, name FROM work_types WHERE id = $1`,
          [current.parent_id],
        );
        newParentRow = parentRows[0] ?? null;
      }

      // Имя и вариант. Родитель — группа (level 4): name пересчитывается через
      // buildLeafName ТОЛЬКО если изменился variant_label или сменился родитель
      // при непустом варианте; иначе name не трогаем (у старых позиций имя могло
      // быть другим), переданный name игнорируется. Родитель не группа: переданный
      // name — итоговое имя, variant_label = NULL.
      const normalizeVariant = (v) => (v != null && String(v).trim() ? String(v).trim() : null);
      const nameFields = {};
      if (newParentRow?.level === 4) {
        const currentVariant = normalizeVariant(current.variant_label);
        const variantInBody = "variant_label" in body;
        const nextVariant = variantInBody ? normalizeVariant(body.variant_label) : currentVariant;
        const variantChanged = variantInBody && nextVariant !== currentVariant;
        if (variantChanged) nameFields.variant_label = nextVariant;
        if (variantChanged || (parentChanged && nextVariant)) {
          nameFields.name = buildLeafName(newParentRow.name, nextVariant);
        }
      } else if ("name" in body) {
        nameFields.name = body.name != null ? String(body.name).trim() : "";
        nameFields.variant_label = null;
      }
      if ("name" in nameFields && !nameFields.name) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Укажите название" });
      }

      // Уникальность имени — только если имя изменилось или лист переехал.
      if ("name" in nameFields || parentChanged) {
        const nameError = await checkNameUniqueAmongSiblings(client, {
          parentId: newParentId,
          catalogType: newCatalogType,
          name: nameFields.name ?? current.name,
          excludeId: id,
        });
        if (nameError) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: nameError });
        }
      }

      const finalGesnCode = "gesn_code" in body
        ? (body.gesn_code != null && String(body.gesn_code).trim() ? String(body.gesn_code).trim() : null)
        : current.gesn_code;
      if (finalGesnCode) {
        const gesnError = await checkGesnCodeUnique(client, newSbornikId, finalGesnCode, id);
        if (gesnError) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: gesnError });
        }
      }

      const setParts = [];
      const values = [];
      let idx = 1;
      for (const [field, value] of Object.entries(nameFields)) {
        setParts.push(`${field} = $${idx}`);
        values.push(value);
        idx += 1;
      }
      for (const field of LEAF_EDITABLE_FIELDS) {
        if (!(field in body)) continue;
        setParts.push(`${field} = $${idx}`);
        if (field === "gesn_code") values.push(finalGesnCode);
        else values.push(body[field]);
        idx += 1;
      }
      if (parentChanged) {
        setParts.push(`parent_id = $${idx}`);
        values.push(newParentId);
        idx += 1;
        setParts.push(`sbornik_id = $${idx}`);
        values.push(newSbornikId);
        idx += 1;
      }
      if (!setParts.length) {
        await client.query("ROLLBACK");
        // Известные поля переданы, но ничего не меняют (напр. name у листа под
        // группой при том же варианте) — не ошибка, отдаём лист как есть.
        const knownKeys = ["name", "variant_label", "parent_id", ...LEAF_EDITABLE_FIELDS];
        if (knownKeys.some((k) => k in body)) {
          return res.json(await buildLeafDetail(pool, id));
        }
        return res.status(400).json({ error: "Нет полей для изменения" });
      }
      values.push(id);

      let updatedRow;
      try {
        const { rows } = await client.query(
          `UPDATE work_types SET ${setParts.join(", ")} WHERE id = $${idx} RETURNING *`,
          values,
        );
        updatedRow = rows[0];
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === "23505" && err.constraint === "idx_work_types_sbornik_gesn_code") {
          return res.status(409).json({ error: `Код ГЭСН «${finalGesnCode}» уже используется в этом сборнике` });
        }
        if (respondWorkTypeDbError(err, res, { duplicateMessage: "Такая позиция уже есть" })) return;
        throw err;
      }

      await cascadeWorkTypeUpdate(client, updatedRow);

      await insertAuditLog(client, {
        entityType: "work_type",
        entityId: id,
        action: "update",
        actorUserId: req.user.id,
        actorName: req.user.full_name,
        before: current,
        after: updatedRow,
      });

      await client.query("COMMIT");

      const detail = await buildLeafDetail(pool, id);
      res.json(detail);
      if (embeddingTextChanged(current, updatedRow)) scheduleEmbeddingRefresh(id);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// POST /nodes — создание узла-контейнера (level 1-4). parent_id === null/
// отсутствует => создаётся корень (level=1), тогда catalog_type обязателен.
// Иначе level по умолчанию parent.level+1; можно передать явно (level — тип
// узла, а не глубина: группа level=4 может лежать прямо под сборником) —
// тогда parent.level < level <= 4, иначе 400 «Недопустимый уровень».
// Контейнер level=4 дочерних контейнеров не имеет, только листья level=5
// (POST /api/work-types), sbornik_id/catalog_type наследуются от родителя
// (catalog_type можно переопределить явно).
workTypesTreeRouter.post(
  "/nodes",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { parent_id, name, catalog_type, sort_order, level: levelRaw } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Укажите название" });
    }

    let parent = null;
    if (parent_id != null && parent_id !== "") {
      const parentId = Number(parent_id);
      if (!Number.isInteger(parentId)) {
        return res.status(400).json({ error: "parent_id должен быть целым числом" });
      }
      const { rows } = await pool.query(
        `SELECT id, level, status, sbornik_id, catalog_type FROM work_types WHERE id = $1`,
        [parentId],
      );
      parent = rows[0];
      if (!parent) return res.status(400).json({ error: "Родительский узел не найден" });
      if (parent.status === "archived") {
        return res.status(400).json({ error: "Родительский узел архивирован" });
      }
      if (parent.level >= 4) {
        return res.status(400).json({ error: "У этого узла не может быть дочерних разделов" });
      }
    } else if (!catalog_type) {
      return res.status(400).json({ error: "Для корневого узла укажите catalog_type" });
    }

    let level = parent ? parent.level + 1 : 1;
    if (parent && levelRaw != null && levelRaw !== "") {
      level = Number(levelRaw);
      if (!Number.isInteger(level) || level <= parent.level || level > 4) {
        return res.status(400).json({ error: "Недопустимый уровень" });
      }
    }
    const resolvedCatalogType = catalog_type || (parent ? parent.catalog_type : null);

    const nameError = await checkNameUniqueAmongSiblings(pool, {
      parentId: parent ? parent.id : null,
      catalogType: resolvedCatalogType,
      name,
      excludeId: null,
    });
    if (nameError) return res.status(409).json({ error: nameError });

    // unit/price NOT NULL (базовая схема таблицы), has_price — как у всех
    // существующих контейнеров и у импортёров каталога: '-', 0, false.
    // source='user_added', а НЕ 'manual': плоский справочник мастеров
    // (GET /api/work-types) берёт source IN ('legacy','manual'), контейнеры
    // в нём быть не должны.
    let newId;
    try {
      const { rows: insertedRows } = await pool.query(
        `INSERT INTO work_types
           (parent_id, level, catalog_type, sbornik_id, name, unit, price, has_price, sort_order, source, status)
         VALUES ($1,$2,$3,$4,$5,'-',0,false,$6,'user_added','active')
         RETURNING id`,
        [
          parent ? parent.id : null,
          level,
          resolvedCatalogType,
          parent ? parent.sbornik_id : null,
          String(name).trim(),
          sort_order ?? 0,
        ],
      );
      newId = insertedRows[0].id;

      // Корень (level=1) — свой собственный sbornik_id (см. миграция 025),
      // известен только после вставки (нужен собственный id).
      if (level === 1) {
        await pool.query(`UPDATE work_types SET sbornik_id = $1 WHERE id = $1`, [newId]);
      }
    } catch (err) {
      if (respondWorkTypeDbError(err, res, { duplicateMessage: "Раздел с таким названием уже есть" })) return;
      throw err;
    }

    const { rows: finalRows } = await pool.query(`SELECT ${TREE_COLUMNS} FROM work_types WHERE id = $1`, [newId]);
    // Свежесозданный узел заведомо без детей — не через fetchChildrenRows
    // (её WHERE требует хотя бы один настоящий лист в поддереве, у пустого
    // контейнера такого ещё нет, и запрос вернул бы 0 строк).
    const node = {
      ...finalRows[0],
      has_children: false,
      has_counter_steps: false,
      can_edit: true,
      can_edit_node: true,
    };

    await insertAuditLog(pool, {
      entityType: "work_type",
      entityId: newId,
      action: "create",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: null,
      after: node,
    });

    res.status(201).json(node);
  }),
);

// POST /batch — создание нескольких листьев под одним контейнером (level 1-4)
// за один запрос. Тело: { parent_id, work_composition?, items: [{ text, unit,
// price, has_price, labor_hours, gesn_code }] }, 1-50 строк. Название листа
// считает СЕРВЕР:
//   - родитель — группа (level 4): text = вариант, name = buildLeafName(группа,
//     вариант), variant_label = вариант или NULL; при нескольких строках вариант
//     обязателен в каждой (одна строка без варианта → name = название группы);
//   - родитель — контейнер level < 4: text = полное название, обязателен,
//     variant_label = NULL.
// Ошибки — с номером строки («Строка N: ...»). Уникальность имени — среди
// неархивных братьев (409 «Такая позиция уже есть в этом месте»), gesn_code — как
// у одиночного создания. Всё в одной транзакции: любая ошибка — ROLLBACK, ничего
// не создаётся. Дубли внутри самого запроса ловятся теми же проверками (они
// видят строки, уже вставленные этой транзакцией). Родитель блокируется FOR
// UPDATE — параллельный запрос не проскочит между проверкой и вставкой. Права
// как у одиночного создания листа: admin и curator.
const BATCH_MAX_ITEMS = 50;

workTypesTreeRouter.post(
  "/batch",
  requireRole("admin", "curator"),
  asyncHandler(async (req, res) => {
    const { parent_id, work_composition, items } = req.body || {};

    const parentId = Number(parent_id);
    if (parent_id == null || parent_id === "" || !Number.isInteger(parentId)) {
      return res.status(400).json({ error: "parent_id обязателен и должен быть целым числом" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Добавьте хотя бы одну позицию" });
    }
    if (items.length > BATCH_MAX_ITEMS) {
      return res.status(400).json({ error: `Не больше ${BATCH_MAX_ITEMS} позиций за один раз` });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { parent, error: parentError } = await loadLeafParent(client, parentId, { forUpdate: true });
      if (parentError) {
        await client.query("ROLLBACK");
        return res.status(parentError.status).json({ error: parentError.error });
      }
      const isGroup = parent.level === 4;

      const createdIds = [];
      for (let i = 0; i < items.length; i += 1) {
        const rowLabel = `Строка ${i + 1}`;
        const item = items[i];
        const rowError = async (status, message) => {
          await client.query("ROLLBACK");
          return res.status(status).json({ error: `${rowLabel}: ${message}` });
        };

        if (item == null || typeof item !== "object" || Array.isArray(item)) {
          return rowError(400, "некорректная позиция");
        }
        const { text, unit, price, has_price, labor_hours, gesn_code } = item;

        if (unit == null || !String(unit).trim()) return rowError(400, "Укажите единицу измерения");
        const priceError = validatePrice(price);
        if (priceError) return rowError(400, priceError);

        const trimmedText = text != null ? String(text).trim() : "";
        let leafName;
        let variantLabel = null;
        if (isGroup) {
          if (!trimmedText && items.length > 1) return rowError(400, "Укажите вариант");
          variantLabel = trimmedText || null;
          leafName = buildLeafName(parent.name, variantLabel);
        } else {
          if (!trimmedText) return rowError(400, "Введите название позиции");
          leafName = trimmedText;
        }
        if (!leafName) return rowError(400, "Введите название позиции");

        const { id, error } = await insertLeaf(
          client,
          parent,
          {
            name: leafName,
            variant_label: variantLabel,
            unit,
            price,
            has_price,
            labor_hours,
            gesn_code,
            work_composition,
          },
          { nameConflictMessage: "Такая позиция уже есть в этом месте" },
        );
        if (error) return rowError(error.status, error.error);
        createdIds.push(id);

        const detail = await buildLeafDetail(client, id);
        await insertAuditLog(client, {
          entityType: "work_type",
          entityId: id,
          action: "create",
          actorUserId: req.user.id,
          actorName: req.user.full_name,
          before: null,
          after: detail,
        });
      }

      // Ответ — в формате /tree (TREE_COLUMNS + has_children/has_counter_steps/
      // can_edit), в порядке создания. Свежесозданные листья заведомо без детей
      // и без шагов-счётчиков — не через fetchChildrenRows.
      const { rows } = await client.query(
        `SELECT ${TREE_COLUMNS} FROM work_types WHERE id = ANY($1) ORDER BY id`,
        [createdIds],
      );
      const created = rows.map((r) =>
        annotateTreeItem({ ...r, has_children: false, has_counter_steps: false }, req.user),
      );

      await client.query("COMMIT");
      res.status(201).json({ items: created });
      scheduleEmbeddingRefresh(createdIds);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// PATCH /nodes/:id — переименование контейнера (+ sort_order). Смена
// родителя намеренно не поддерживается здесь (не нужна по ТЗ) — для узлов
// это отдельная операция, которой пока нет. Архивация — отдельным
// PATCH /nodes/:id/archive ниже.
workTypesTreeRouter.patch(
  "/nodes/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }

    const { rows: currentRows } = await pool.query(
      `SELECT id, parent_id, level, catalog_type, sbornik_id, name, sort_order, status
         FROM work_types WHERE id = $1`,
      [id],
    );
    const current = currentRows[0];
    if (!current) return res.status(404).json({ error: "not found" });
    if (current.level === 5) {
      return res.status(400).json({ error: "Это лист — используйте /:id/edit" });
    }

    const body = req.body || {};
    if (!("name" in body) && !("sort_order" in body)) {
      return res.status(400).json({ error: "Нет полей для изменения" });
    }

    const finalName = "name" in body ? body.name : current.name;
    if (!finalName || !String(finalName).trim()) {
      return res.status(400).json({ error: "Укажите название" });
    }

    if ("name" in body) {
      const nameError = await checkNameUniqueAmongSiblings(pool, {
        parentId: current.parent_id,
        catalogType: current.catalog_type,
        name: finalName,
        excludeId: id,
      });
      if (nameError) return res.status(409).json({ error: nameError });
    }

    const setParts = [];
    const values = [];
    let idx = 1;
    if ("name" in body) {
      setParts.push(`name = $${idx}`);
      values.push(String(body.name).trim());
      idx += 1;
    }
    if ("sort_order" in body) {
      if (body.sort_order == null) {
        return res.status(400).json({ error: "Не заполнено обязательное поле" });
      }
      setParts.push(`sort_order = $${idx}`);
      values.push(body.sort_order);
      idx += 1;
    }
    values.push(id);

    let updated;
    try {
      const { rows } = await pool.query(
        `UPDATE work_types SET ${setParts.join(", ")}
         WHERE id = $${idx}
         RETURNING id, parent_id, level, catalog_type, sbornik_id, name, sort_order, status`,
        values,
      );
      updated = rows[0];
    } catch (err) {
      if (respondWorkTypeDbError(err, res, { duplicateMessage: "Раздел с таким названием уже есть" })) return;
      throw err;
    }

    await insertAuditLog(pool, {
      entityType: "work_type",
      entityId: id,
      action: "update",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: current,
      after: updated,
    });

    res.json({ ...updated, can_edit: true, can_edit_node: true });
  }),
);

// PATCH /nodes/:id/archive — архивация контейнера. Отдельно от общего
// PATCH /:id/archive (directories.js, работает и для листьев, и для
// контейнеров) — этот путь только для контейнеров и только admin (curator
// не может архивировать разделы дерева, в отличие от листьев). Общая логика
// (включая запрет архивации при неархивных листьях внутри) — в
// archiveWorkType (work-types-shared.js), чтобы не дублировать SQL.
workTypesTreeRouter.patch(
  "/nodes/:id/archive",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }

    const { rows: checkRows } = await pool.query(`SELECT level FROM work_types WHERE id = $1`, [id]);
    if (!checkRows[0]) return res.status(404).json({ error: "not found" });
    if (checkRows[0].level === 5) {
      return res.status(400).json({ error: "Это лист — используйте /:id/archive" });
    }

    const result = await archiveWorkType(pool, id);
    if (result.conflict) return res.status(409).json({ error: result.conflict });

    await insertAuditLog(pool, {
      entityType: "work_type",
      entityId: id,
      action: "update",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: result.before,
      after: result.after,
    });

    res.json({ ...result.after, can_edit_node: true });
  }),
);

// GET /nodes/:id/usage — диагностика перед архивацией/правкой контейнера:
// сколько живых/архивных листьев и подконтейнеров у него в поддереве (на
// любой глубине) и сколько record_items ссылаются на его листья. Только
// admin — тот же круг, что и остальные /nodes-эндпоинты.
workTypesTreeRouter.get(
  "/nodes/:id/usage",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id должен быть целым числом" });
    }

    const { rows: nodeRows } = await pool.query(
      `SELECT id, level, name, status FROM work_types WHERE id = $1`,
      [id],
    );
    const node = nodeRows[0];
    if (!node) return res.status(404).json({ error: "not found" });
    if (node.level === 5) {
      return res.status(400).json({ error: "Это лист — используйте /:id/detail" });
    }

    const { rows: countRows } = await pool.query(
      `WITH RECURSIVE sub AS (
         SELECT id, level, status FROM work_types WHERE id = $1
         UNION ALL
         SELECT wt.id, wt.level, wt.status FROM work_types wt JOIN sub ON wt.parent_id = sub.id
       )
       SELECT
         count(*) FILTER (WHERE level = 5 AND status <> 'archived') AS leaves_active,
         count(*) FILTER (WHERE level = 5 AND status = 'archived') AS leaves_archived,
         count(*) FILTER (WHERE level < 5 AND status <> 'archived' AND id <> $1) AS containers_active,
         count(*) FILTER (WHERE level < 5 AND status = 'archived' AND id <> $1) AS containers_archived
       FROM sub`,
      [id],
    );

    const { rows: recordRows } = await pool.query(
      `WITH RECURSIVE sub AS (
         SELECT id, level FROM work_types WHERE id = $1
         UNION ALL
         SELECT wt.id, wt.level FROM work_types wt JOIN sub ON wt.parent_id = sub.id
       )
       SELECT count(*) AS record_items_count
       FROM record_items
       WHERE work_type_id IN (SELECT id FROM sub WHERE level = 5)`,
      [id],
    );

    res.json({
      id: node.id,
      name: node.name,
      level: node.level,
      status: node.status,
      leaves_active: Number(countRows[0].leaves_active),
      leaves_archived: Number(countRows[0].leaves_archived),
      containers_active: Number(countRows[0].containers_active),
      containers_archived: Number(countRows[0].containers_archived),
      record_items_count: Number(recordRows[0].record_items_count),
    });
  }),
);
