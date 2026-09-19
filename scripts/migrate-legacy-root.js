// Перенос старых позиций (source='legacy', плоско под синтетическим корнем
// legacy_root) на их места в новом каскадном каталоге, найденные среди копий,
// заведённых импортом svod-2026-08.xlsx (source='user_added', legacy_num —
// номер строки исходного файла). Стиль и общая структура — по образцу
// import-user-catalog.js / import-additional-sborniks.js (dotenv, --dry-run/
// --apply, BEGIN/COMMIT/ROLLBACK, printReport перед выполнением), но с
// дополнительным режимом (--plan/--confirm), т.к. здесь, в отличие от тех
// скриптов, план — не тривиальная вставка новых строк, а неоднозначное
// сопоставление, требующее ручного review CSV/JSON между dry-run и apply.
//
// КРИТИЧНО про id: id на staging и прод РАЗНЫЕ (независимые окружения, БД не
// синхронизированы). План (/tmp/legacy_plan.json), сгенерированный dry-run'ом
// на одном окружении, не может адресовать строки другого окружения через
// свои legacy_id/copy_id — это просто числа для отчёта. Поэтому:
//   - старая (legacy) строка резолвится в момент --apply заново по её
//     old_n (см. ниже) — запасной ключ: name+unit (без учёта регистра/
//     пробелов), только когда old_n отсутствует;
//   - копия резолвится по её legacy_num (миграция 024).
// Оба ключа стабильны между окружениями (в отличие от id), поэтому план,
// сформированный на staging, в принципе применим и на проде — план просто
// нужно СГЕНЕРИРОВАТЬ ЗАНОВО (--dry-run) на целевом окружении.
//
// old_n — колонка из старого Flask-приложения (UNIQUE), для строк,
// перенесённых при миграции на текущий бэкенд. Ни один файл в migrations/
// её не создаёт — предположительно часть базовой схемы до появления
// schema_migrations (миграция 001). Скрипт проверяет её наличие через
// information_schema перед началом работы и падает с понятным сообщением,
// если её вдруг нет.
//
// Близнецы-копии (twins): если у legacy-строки при автосопоставлении
// (тиры K/T1-T4) оказалось НЕСКОЛЬКО кандидатов, но все они с одинаковыми
// нормализованными name/unit/price И одинаковым parent_id — это не
// настоящая неоднозначность, а дублирующиеся строки копии (одна и та же
// позиция завелась в БД несколько раз). action=move_and_archive_twins:
// слот — копия с минимальным id, остальные архивируются, их record_items
// тоже перепривязываются на перенесённую строку.
//
// Поправки (scripts/data/legacy_overrides.json, { rows: [...] }) — два вида
// строк, различаются наличием поля action:
//   - С action (match_copy/place_next_to/archive/delete_if_unreferenced) —
//     ПОЛНОСТЬЮ заменяют автосопоставление для этой legacy-строки: строка
//     вынимается из обычного пайплайна (T1-T5/дубли/tier K) ДО его запуска.
//     Адресация строки — old_n, либо (если old_n нет) точное совпадение
//     name. Адресация копии (для match_copy/place_next_to) — ТОЛЬКО по
//     имени (copy_name, нормализованное совпадение среди активных
//     source='user_added') — не по id (id разный на staging/проде); если
//     совпадений 0 или больше 1 — строка помечается override_unresolved со
//     списком всех найденных вариантов, скрипт не гадает и не падает
//     целиком.
//   - Без action, только { old_n, set_unit?, set_price? } — НЕ меняют, к
//     какой копии привязывается строка: это правка поверх результата
//     ОБЫЧНОГО автосопоставления (ожидается action=move/match_copy/
//     move_and_archive_twins) — применяется ПОСЛЕ основного пайплайна,
//     просто подставляет свои unit/price в уже готовую move-строку. Если
//     строка с этим old_n не свелась к move-семейству (конфликт/подсказка/
//     ручная) — поправка НЕ применяется, это явно видно в отчёте.
import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const PLAN_CSV_PATH = "/tmp/legacy_plan.csv";
const PLAN_JSON_PATH = "/tmp/legacy_plan.json";
const OVERRIDES_FILE = fileURLToPath(new URL("./data/legacy_overrides.json", import.meta.url));

// Тот же дефолт, что и src/db.js — используется как "origin" плана
// (записывается в plan.json), чтобы --apply мог отказаться применить план
// staging на проде или наоборот (см. main()).
function resolveDbName() {
  return process.env.DB_NAME || "uchet_db";
}

// dry-run переписывает эти файлы только при УСПЕШНОМ построении плана —
// если buildPlan() бросает исключение (например, двойное занятие копии),
// свежий прогон не должен оставить после себя ни старые (устаревшие), ни
// частично записанные файлы, которые можно принять за актуальный план.
function removeStalePlanFiles() {
  for (const p of [PLAN_CSV_PATH, PLAN_JSON_PATH]) {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

// Порог для гипотезы "old_n старой строки равен legacy_num её копии"
// (см. testTierKHypothesis). На staging гипотеза НЕ подтвердилась (8 из
// 773) — с 90%-порогом tier K там автоматически отключён. Порог, а не
// жёстко "выключено", — чтобы скрипт остался рабочим, если на другом
// окружении (или после исправления данных) ключ вдруг совпадёт почти всегда.
const TIER_K_THRESHOLD = 0.9;

// Синонимы единиц измерения — нижний регистр, без точек/пробелов (сначала
// stripUnit, потом поиск в этой таблице). Список собран по частым вариантам
// написания в конструкторских сметах; для единиц вне списка используется
// просто lower+strip без канонизации (см. normalizeUnit).
const UNIT_SYNONYMS = new Map([
  ["м2", "м2"], ["м²", "м2"], ["квм", "м2"], ["кв2м", "м2"],
  ["мп", "мп"], ["погм", "мп"], ["пм", "мп"], ["м/п", "мп"],
  ["шт", "шт"], ["штук", "шт"], ["штуки", "шт"],
  ["м3", "м3"], ["м³", "м3"], ["кубм", "м3"],
  ["т", "т"], ["тонн", "т"], ["тонна", "т"],
  ["кг", "кг"], ["килограмм", "кг"],
]);

function stripUnit(unit) {
  return String(unit ?? "").toLowerCase().replace(/[.\s]/g, "");
}

function normalizeUnit(unit) {
  const stripped = stripUnit(unit);
  return UNIT_SYNONYMS.get(stripped) ?? stripped;
}

// Базовая нормализация имени (T1-T3): lower, ё->е, схлопнуть пробелы, trim.
function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

// Строгая нормализация (T4/T5): плюс убрать скобки/запятые/кавычки — нужна
// для сравнения "имя листа" с "родитель.name + variant_label" — эти два
// текста чаще расходятся именно пунктуацией, а не словами.
function normalizeNameStrict(name) {
  return normalizeName(name)
    .replace(/[()«»"'.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalizedStrict) {
  return normalizedStrict.split(" ").filter((t) => t.length > 1);
}

function pricesEqual(a, b) {
  if (a == null || b == null) return a === b;
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

// Близнецы: несколько кандидатов-копий, но все с одинаковыми
// нормализованными name/unit/price И одинаковым parent_id — не настоящая
// неоднозначность, а дублирующиеся строки одной и той же позиции.
function areTwins(candidates) {
  if (candidates.length < 2) return false;
  const first = candidates[0];
  return candidates.every(
    (c) =>
      c.nameNorm === first.nameNorm &&
      c.unitNorm === first.unitNorm &&
      pricesEqual(c.price, first.price) &&
      c.parentId === first.parentId,
  );
}

function parseArgs() {
  const rest = process.argv.slice(2);
  const getOpt = (name) => {
    const idx = rest.indexOf(name);
    return idx >= 0 ? rest[idx + 1] : null;
  };
  return {
    apply: rest.includes("--apply"),
    confirm: rest.includes("--confirm"),
    planPath: getOpt("--plan"),
    selfTest: rest.includes("--self-test"),
  };
}

// ---------------------------------------------------------------------------
// Загрузка данных (только SELECT — используется и в dry-run, и как первый
// шаг apply при резолве строк по портируемым ключам).
// ---------------------------------------------------------------------------

async function assertOldNColumn(client) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'work_types' AND column_name = 'old_n'`,
  );
  if (!rows.length) {
    throw new Error(
      "В work_types нет колонки old_n. Скрипт написан в предположении, что она есть " +
        "(колонка из старого Flask-приложения, УНИКАЛЬНАЯ) — без неё резолв старых строк " +
        "между окружениями не сработает как задумано.",
    );
  }
}

async function loadRoot(client) {
  const { rows } = await client.query(`SELECT id, name FROM work_types WHERE source = 'legacy_root'`);
  if (rows.length !== 1) {
    throw new Error(`Ожидался ровно один узел source='legacy_root', найдено: ${rows.length}`);
  }
  return rows[0];
}

async function loadLegacyRows(client, rootId) {
  const { rows } = await client.query(
    `SELECT wt.id, wt.old_n, wt.name, wt.unit, wt.price,
            COALESCE(ri.cnt, 0)::int AS record_items_count
       FROM work_types wt
       LEFT JOIN (
         SELECT work_type_id, count(*) AS cnt FROM record_items GROUP BY work_type_id
       ) ri ON ri.work_type_id = wt.id
      WHERE wt.parent_id = $1 AND wt.source = 'legacy' AND wt.level = 5 AND wt.status = 'active'
      ORDER BY wt.id`,
    [rootId],
  );
  return rows.map((r) => ({
    id: r.id,
    oldN: r.old_n,
    name: r.name,
    unit: r.unit,
    price: r.price,
    recordItemsCount: r.record_items_count,
    nameNorm: normalizeName(r.name),
    unitNorm: normalizeUnit(r.unit),
    nameNormStrict: normalizeNameStrict(r.name),
  }));
}

async function loadArchivedLegacyCount(client, rootId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS cnt FROM work_types
      WHERE parent_id = $1 AND source = 'legacy' AND level = 5 AND status = 'archived'`,
    [rootId],
  );
  return rows[0].cnt;
}

// Предки копии (level 1-4, сколько бы их реально ни было — parent_id может
// вести напрямую к level 1-3, см. work-types-tree.js) — тот же паттерн
// рекурсивного подъёма, что и getAncestorChain в src/routes/work-types-shared.js.
// Любой статус (не только active) — см. loadCopyRows: place_next_to должен
// уметь резолвить якорь, даже если он уже архивен (до начала работы скрипта,
// или архивируется другой строкой ЭТОГО ЖЕ плана — place_next_to читает у
// копии только parent_id/catalog_type/sbornik_id, которые архивация не
// трогает, см. buildPlan/applyOverrides).
async function loadCopyAncestors(client) {
  const { rows } = await client.query(
    `WITH RECURSIVE anc AS (
       SELECT leaf.id AS leaf_id, p.id, p.parent_id, p.level, p.name
         FROM work_types leaf
         JOIN work_types p ON p.id = leaf.parent_id
        WHERE leaf.source = 'user_added' AND leaf.legacy_num IS NOT NULL
       UNION ALL
       SELECT a.leaf_id, p2.id, p2.parent_id, p2.level, p2.name
         FROM anc a
         JOIN work_types p2 ON p2.id = a.parent_id
     )
     SELECT leaf_id, id, level, name FROM anc ORDER BY leaf_id, level`,
  );
  const byLeaf = new Map();
  for (const row of rows) {
    if (!byLeaf.has(row.leaf_id)) byLeaf.set(row.leaf_id, []);
    byLeaf.get(row.leaf_id).push({ id: row.id, level: row.level, name: row.name });
  }
  return byLeaf;
}

// Загружает ВСЕ user_added-копии (любой status — active и archived), с
// полем status в результате. Вызывающий код сам решает, кому нужен только
// active-подмножество (T1-T5/tier K/match_copy — резолв в РЕАЛЬНО свободный,
// не архивный слот) и кому годится любой статус (place_next_to — см. выше).
async function loadCopyRows(client) {
  const { rows } = await client.query(
    `SELECT u.id, u.legacy_num, u.name, u.unit, u.price, u.parent_id, u.sbornik_id, u.catalog_type,
            u.sort_order, u.variant_label, u.status, p.name AS parent_name,
            COALESCE(ri.cnt, 0)::int AS record_items_count
       FROM work_types u
       LEFT JOIN work_types p ON p.id = u.parent_id
       LEFT JOIN (
         SELECT work_type_id, count(*) AS cnt FROM record_items GROUP BY work_type_id
       ) ri ON ri.work_type_id = u.id
      WHERE u.source = 'user_added' AND u.legacy_num IS NOT NULL
      ORDER BY u.id`,
  );
  const ancestorsByLeaf = await loadCopyAncestors(client);

  return rows.map((r) => {
    const ancestors = ancestorsByLeaf.get(r.id) ?? [];
    const displayLeaf = r.variant_label && r.variant_label.trim() ? r.variant_label : r.name;
    const path = [...ancestors.map((a) => a.name), displayLeaf].join(" / ");

    // T4-цели: строгая нормализация «родитель.name + variant_label» (только
    // если variant_label реально есть) и «copy.name» — см. normalizeNameStrict.
    const t4Targets = [];
    if (r.variant_label && r.variant_label.trim() && r.parent_name) {
      t4Targets.push(normalizeNameStrict(`${r.parent_name} ${r.variant_label}`));
    }
    t4Targets.push(normalizeNameStrict(r.name));

    const combinedTokens = new Set();
    for (const t of t4Targets) for (const tok of tokenize(t)) combinedTokens.add(tok);

    return {
      id: r.id,
      legacyNum: r.legacy_num,
      name: r.name,
      unit: r.unit,
      price: r.price,
      parentId: r.parent_id,
      sbornikId: r.sbornik_id,
      catalogType: r.catalog_type,
      sortOrder: r.sort_order,
      variantLabel: r.variant_label,
      status: r.status,
      parentName: r.parent_name,
      recordItemsCount: r.record_items_count,
      nameNorm: normalizeName(r.name),
      unitNorm: normalizeUnit(r.unit),
      t4Targets,
      combinedTokens,
      path,
    };
  });
}

// Ссылки на конкретную строку work_types (для delete_if_unreferenced) —
// record_items.work_type_id, work_types.parent_id, work_types.step_base_work_type_id
// (единственные FK на work_types(id), см. миграции 009/017 и round-2
// диагностику legacy_root: requests на work_types вообще не ссылается).
async function countReferences(client, id) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM record_items WHERE work_type_id = $1) AS record_items_count,
       (SELECT count(*)::int FROM work_types WHERE parent_id = $1) AS children_count,
       (SELECT count(*)::int FROM work_types WHERE step_base_work_type_id = $1) AS step_base_refs_count`,
    [id],
  );
  return {
    recordItemsCount: rows[0].record_items_count,
    childrenCount: rows[0].children_count,
    stepBaseRefsCount: rows[0].step_base_refs_count,
  };
}

// ---------------------------------------------------------------------------
// Индексы + сопоставление (T1-T5, tier K, близнецы).
// ---------------------------------------------------------------------------

function buildCopyIndices(copies) {
  const byNameNorm = new Map();
  const byLegacyNum = new Map();
  const byT4Target = new Map();
  for (const c of copies) {
    if (!byNameNorm.has(c.nameNorm)) byNameNorm.set(c.nameNorm, []);
    byNameNorm.get(c.nameNorm).push(c);

    if (!byLegacyNum.has(c.legacyNum)) byLegacyNum.set(c.legacyNum, []);
    byLegacyNum.get(c.legacyNum).push(c);

    for (const target of c.t4Targets) {
      if (!byT4Target.has(target)) byT4Target.set(target, []);
      byT4Target.get(target).push(c);
    }
  }
  return { byNameNorm, byLegacyNum, byT4Target };
}

// T1-подмножество (имя+ед.+цена точно совпали) — используется и гипотезой
// tier K, и определением победителя среди дублей имён (п.5 предыдущего ТЗ).
function findT1Matches(legacyRow, indices) {
  const nameMatches = indices.byNameNorm.get(legacyRow.nameNorm) ?? [];
  return nameMatches.filter((c) => c.unitNorm === legacyRow.unitNorm && pricesEqual(c.price, legacyRow.price));
}

function testTierKHypothesis(legacyRows, indices) {
  let pairs = 0;
  let comparable = 0;
  let equal = 0;
  for (const row of legacyRows) {
    const matches = findT1Matches(row, indices);
    if (matches.length !== 1) continue;
    pairs++;
    const copy = matches[0];
    if (row.oldN == null || copy.legacyNum == null) continue;
    comparable++;
    if (Number(row.oldN) === Number(copy.legacyNum)) equal++;
  }
  const ratio = comparable > 0 ? equal / comparable : 0;
  return {
    pairs,
    comparable,
    equal,
    ratio,
    enabled: comparable > 0 && ratio >= TIER_K_THRESHOLD,
  };
}

function detectDuplicateGroups(legacyRows) {
  const byName = new Map();
  for (const row of legacyRows) {
    if (!byName.has(row.nameNorm)) byName.set(row.nameNorm, []);
    byName.get(row.nameNorm).push(row);
  }
  return [...byName.values()].filter((rows) => rows.length > 1);
}

function resolveDuplicateWinners(groups, indices) {
  const loserIds = new Set();
  const winnerOf = new Map();
  const groupInfo = [];
  for (const rows of groups) {
    const scored = rows.map((row) => ({ row, hasT1: findT1Matches(row, indices).length > 0 }));
    scored.sort((a, b) => {
      if (a.hasT1 !== b.hasT1) return a.hasT1 ? -1 : 1;
      if (a.row.recordItemsCount !== b.row.recordItemsCount) return b.row.recordItemsCount - a.row.recordItemsCount;
      return a.row.id - b.row.id;
    });
    const winner = scored[0].row;
    const losers = scored.slice(1).map((s) => s.row);
    for (const l of losers) {
      loserIds.add(l.id);
      winnerOf.set(l.id, winner);
    }
    groupInfo.push({
      nameNorm: rows[0].nameNorm,
      winnerId: winner.id,
      winnerOldN: winner.oldN,
      loserIds: losers.map((l) => l.id),
    });
  }
  return { loserIds, winnerOf, groupInfo };
}

function suggestTopMatches(legacyRow, copies, limit = 3) {
  const legacyTokens = new Set(tokenize(legacyRow.nameNormStrict));
  if (!legacyTokens.size) return [];
  const scored = [];
  for (const copy of copies) {
    let overlap = 0;
    for (const t of legacyTokens) if (copy.combinedTokens.has(t)) overlap++;
    if (overlap > 0) scored.push({ copy, score: overlap });
  }
  scored.sort((a, b) => b.score - a.score || a.copy.id - b.copy.id);
  return scored.slice(0, limit);
}

function matchTiers(legacyRow, indices, copies, tierKEnabled) {
  if (tierKEnabled && legacyRow.oldN != null) {
    const kMatches = indices.byLegacyNum.get(Number(legacyRow.oldN)) ?? [];
    if (kMatches.length) return { tier: "K", candidates: kMatches };
  }

  const nameMatches = indices.byNameNorm.get(legacyRow.nameNorm) ?? [];
  if (nameMatches.length) {
    const sameUnit = nameMatches.filter((c) => c.unitNorm === legacyRow.unitNorm);
    if (sameUnit.length) {
      const samePrice = sameUnit.filter((c) => pricesEqual(c.price, legacyRow.price));
      if (samePrice.length) return { tier: "T1", candidates: samePrice };
      return { tier: "T2", candidates: sameUnit };
    }
    return { tier: "T3", candidates: nameMatches };
  }

  const t4Matches = indices.byT4Target.get(legacyRow.nameNormStrict) ?? [];
  if (t4Matches.length) {
    const uniqById = [...new Map(t4Matches.map((c) => [c.id, c])).values()];
    return { tier: "T4", candidates: uniqById };
  }

  const suggestions = suggestTopMatches(legacyRow, copies, 3);
  return { tier: "T5", candidates: suggestions.map((s) => s.copy), suggestions };
}

// Глобальная проверка конфликтов: одна копия не может достаться двум legacy-
// строкам. Тиры K/T1-T4 с несколькими кандидатами сначала проверяются на
// близнецов (areTwins) — если все кандидаты идентичны по name/unit/price/
// parent_id, это не конфликт, а move_and_archive_twins. T5 никогда не
// автоплан, в претензии на копию не участвует.
function resolveConflicts(matchResults) {
  const claims = new Map(); // copyId -> [legacyId,...]
  for (const m of matchResults) {
    if (["K", "T1", "T2", "T3", "T4"].includes(m.tier) && m.candidates.length === 1) {
      const cid = m.candidates[0].id;
      if (!claims.has(cid)) claims.set(cid, []);
      claims.get(cid).push(m.row.id);
    }
  }

  return matchResults.map((m) => {
    if (m.tier === "T5") {
      if (!m.candidates.length) {
        return { ...m, status: "manual", notes: "нет похожих кандидатов (T5, пересечение токенов = 0)" };
      }
      const notes = m.suggestions.map((s) => `id=${s.copy.id}(score=${s.score}) ${s.copy.path}`).join(" | ");
      return { ...m, status: "suggestion", notes: `подсказки (не автоплан): ${notes}` };
    }

    if (m.candidates.length > 1) {
      if (areTwins(m.candidates)) {
        const sorted = [...m.candidates].sort((a, b) => a.id - b.id);
        const primary = sorted[0];
        const twins = sorted.slice(1);
        const contestedByOthers = [primary, ...twins].some((c) => claims.has(c.id));
        if (!contestedByOthers) {
          const ids = m.candidates.map((c) => c.id).join(",");
          return {
            ...m,
            status: "move_and_archive_twins",
            primary,
            twins,
            notes: `тир ${m.tier}: ${m.candidates.length} копий-близнецов (copy_id=${ids}), слот=copy_id=${primary.id}`,
          };
        }
      }
      const ids = m.candidates.map((c) => c.id).join(",");
      return { ...m, status: "conflict", notes: `тир ${m.tier}: несколько кандидатов copy_id=${ids}` };
    }

    const cid = m.candidates[0].id;
    const contenders = claims.get(cid);
    if (contenders.length > 1) {
      const others = contenders.filter((id) => id !== m.row.id);
      return { ...m, status: "conflict", notes: `copy_id=${cid} также запрошена legacy_id=${others.join(",")}` };
    }
    return { ...m, status: "move", notes: `тир ${m.tier}` };
  });
}

// ---------------------------------------------------------------------------
// Сборка строк отчёта (общий формат для CSV/JSON — JSON несёт дополнительные
// машиночитаемые поля, которых нет в CSV).
// ---------------------------------------------------------------------------

function computeDiffFlags(legacyRow, candidate) {
  if (!candidate) return "";
  const flags = [];
  if (!pricesEqual(legacyRow.price, candidate.price)) flags.push("price_diff");
  if (legacyRow.unitNorm !== candidate.unitNorm) flags.push("unit_diff");
  return flags.join(";");
}

// Общие для всех строк плана поля-заглушки — чтобы CSV/JSON имели
// стабильную форму независимо от того, каким путём (алгоритм/override)
// строка была построена.
const ROW_DEFAULTS = {
  twin_copy_legacy_nums: [],
  winner_old_n: null,
  winner_legacy_id: null,
  predicted_delete: null,
  ref_counts: null,
  override_unit: null,
  override_price: null,
  override_key: null,
  // Заморожены при построении плана для place_next_to (см.
  // buildOverridePlaceNextToRow) — apply использует их как есть, не
  // резолвит копию заново.
  anchor_parent_id: null,
  anchor_catalog_type: null,
  anchor_sbornik_id: null,
};

function buildRowFromMatch(m) {
  if (m.status === "move_and_archive_twins") {
    return {
      legacy_id: m.row.id,
      old_n: m.row.oldN,
      legacy_name: m.row.name,
      legacy_unit: m.row.unit,
      legacy_price: m.row.price,
      record_items: m.row.recordItemsCount,
      tier: m.tier,
      copy_id: m.primary.id,
      copy_legacy_num: m.primary.legacyNum,
      copy_path: m.primary.path,
      copy_unit: m.primary.unit,
      copy_price: m.primary.price,
      diff_flags: computeDiffFlags(m.row, m.primary),
      action: "move_and_archive_twins",
      notes: m.notes,
      ...ROW_DEFAULTS,
      twin_copy_legacy_nums: m.twins.map((t) => t.legacyNum),
    };
  }
  const candidate = m.status === "move" ? m.candidates[0] : null;
  return {
    legacy_id: m.row.id,
    old_n: m.row.oldN,
    legacy_name: m.row.name,
    legacy_unit: m.row.unit,
    legacy_price: m.row.price,
    record_items: m.row.recordItemsCount,
    tier: m.tier,
    copy_id: candidate ? candidate.id : null,
    copy_legacy_num: candidate ? candidate.legacyNum : null,
    copy_path: candidate ? candidate.path : "",
    copy_unit: candidate ? candidate.unit : "",
    copy_price: candidate ? candidate.price : null,
    diff_flags: candidate ? computeDiffFlags(m.row, candidate) : "",
    action: m.status,
    notes: m.notes,
    ...ROW_DEFAULTS,
  };
}

function buildMergeRow(loserRow, winnerRow) {
  return {
    legacy_id: loserRow.id,
    old_n: loserRow.oldN,
    legacy_name: loserRow.name,
    legacy_unit: loserRow.unit,
    legacy_price: loserRow.price,
    record_items: loserRow.recordItemsCount,
    tier: null,
    copy_id: null,
    copy_legacy_num: null,
    copy_path: "",
    copy_unit: "",
    copy_price: null,
    diff_flags: "dup_name",
    action: "merge_into_winner",
    notes: `дубль имени → merge в legacy_id=${winnerRow.id} (old_n=${winnerRow.oldN ?? "—"})`,
    ...ROW_DEFAULTS,
    winner_old_n: winnerRow.oldN,
    winner_legacy_id: winnerRow.id,
  };
}

// ---------------------------------------------------------------------------
// Поправки (scripts/data/legacy_overrides.json) — см. заголовок файла про
// два вида строк (с action / только set_unit/set_price).
// ---------------------------------------------------------------------------

function loadOverridesFile() {
  if (!fs.existsSync(OVERRIDES_FILE)) return { fullOverrides: [], adjustments: [] };
  const raw = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  const rows = raw.rows ?? [];
  return {
    fullOverrides: rows.filter((r) => r.action),
    adjustments: rows.filter((r) => !r.action),
  };
}

function baseOverrideFields(legacyRow) {
  return {
    legacy_id: legacyRow.id,
    old_n: legacyRow.oldN,
    legacy_name: legacyRow.name,
    legacy_unit: legacyRow.unit,
    legacy_price: legacyRow.price,
    record_items: legacyRow.recordItemsCount,
    tier: "OVR",
    ...ROW_DEFAULTS,
  };
}

function buildOverrideErrorRow(ov, message, legacyRow, overrideKey) {
  return {
    legacy_id: legacyRow ? legacyRow.id : null,
    old_n: legacyRow ? legacyRow.oldN : (ov.old_n ?? null),
    legacy_name: legacyRow ? legacyRow.name : (ov.name ?? null),
    legacy_unit: legacyRow ? legacyRow.unit : null,
    legacy_price: legacyRow ? legacyRow.price : null,
    record_items: legacyRow ? legacyRow.recordItemsCount : 0,
    tier: "OVR",
    copy_id: null,
    copy_legacy_num: null,
    copy_path: "",
    copy_unit: "",
    copy_price: null,
    diff_flags: "",
    action: "override_unresolved",
    notes: message,
    ...ROW_DEFAULTS,
    override_key: overrideKey,
  };
}

function buildOverrideCopyAmbiguousRow(legacyRow, ov, candidates, overrideKey) {
  const list = candidates.length
    ? candidates.map((c) => `id=${c.id} legacy_num=${c.legacyNum} status=${c.status} "${c.path}"`).join(" | ")
    : "(ничего не найдено)";
  return {
    ...baseOverrideFields(legacyRow),
    copy_id: null,
    copy_legacy_num: null,
    copy_path: "",
    copy_unit: "",
    copy_price: null,
    diff_flags: "",
    action: "override_unresolved",
    notes: `copy_name="${ov.copy_name}" — найдено ${candidates.length} совпадений: ${list}`,
    override_key: overrideKey,
  };
}

function buildOverrideArchiveRow(legacyRow, ov, overrideKey) {
  return {
    ...baseOverrideFields(legacyRow),
    copy_id: null,
    copy_legacy_num: null,
    copy_path: "",
    copy_unit: "",
    copy_price: null,
    diff_flags: "",
    action: "archive",
    notes: "override: archive",
    override_key: overrideKey,
  };
}

async function buildOverrideDeleteRow(client, legacyRow, ov, overrideKey) {
  const refs = await countReferences(client, legacyRow.id);
  const total = refs.recordItemsCount + refs.childrenCount + refs.stepBaseRefsCount;
  return {
    ...baseOverrideFields(legacyRow),
    copy_id: null,
    copy_legacy_num: null,
    copy_path: "",
    copy_unit: "",
    copy_price: null,
    diff_flags: "",
    action: "delete_if_unreferenced",
    notes:
      total === 0
        ? "ссылок нет (record_items=0, children=0, step_base_refs=0) — будет физически удалена"
        : `есть ссылки (record_items=${refs.recordItemsCount}, children=${refs.childrenCount}, ` +
          `step_base_refs=${refs.stepBaseRefsCount}) — будет заархивирована вместо удаления`,
    predicted_delete: total === 0,
    ref_counts: refs,
    override_key: overrideKey,
  };
}

function buildOverrideMatchCopyRow(legacyRow, copy, ov, overrideKey) {
  return {
    ...baseOverrideFields(legacyRow),
    copy_id: copy.id,
    copy_legacy_num: copy.legacyNum,
    copy_path: copy.path,
    copy_unit: copy.unit,
    copy_price: copy.price,
    diff_flags: computeDiffFlags(legacyRow, copy),
    action: "match_copy",
    notes: `override match_copy: "${ov.copy_name}"`,
    override_unit: ov.set_unit ?? null,
    override_price: ov.set_price ?? null,
    override_key: overrideKey,
  };
}

// Якорь place_next_to резолвится и его parent_id/catalog_type/sbornik_id
// читаются ОДИН РАЗ здесь, при построении плана, и замораживаются в строку
// плана (anchor_*) — эти три поля не меняются архивацией строки, поэтому не
// нужно (и вредно, см. заголовок файла) перерезолвливать копию заново на
// --apply: там используются anchor_* как есть, без обращения к текущему
// статусу/данным копии.
function buildOverridePlaceNextToRow(legacyRow, copy, ov, overrideKey) {
  const archivedWarning =
    copy.status === "archived"
      ? ` [копия-якорь уже архивна на момент построения плана (не этим планом — см. заголовок файла); ` +
        `используются её сохранённые parent_id=${copy.parentId}/catalog_type/sbornik_id]`
      : "";
  return {
    ...baseOverrideFields(legacyRow),
    copy_id: copy.id,
    copy_legacy_num: copy.legacyNum,
    copy_path: copy.path,
    copy_unit: copy.unit,
    copy_price: copy.price,
    diff_flags: computeDiffFlags(legacyRow, copy),
    action: "place_next_to",
    notes:
      `override place_next_to: "${ov.copy_name}" (parent_id/catalog_type/sbornik_id копии — снимок на момент ` +
      `построения плана, sort_order = max+1 (пересчитывается заново на apply), variant_label=NULL, своё имя и ` +
      `unit/price сохраняются, копия не архивируется)${archivedWarning}`,
    override_unit: ov.set_unit ?? null,
    override_price: ov.set_price ?? null,
    override_key: overrideKey,
    anchor_parent_id: copy.parentId,
    anchor_catalog_type: copy.catalogType,
    anchor_sbornik_id: copy.sbornikId,
  };
}

// Полные поправки (с action) — вынимают строку из обычного пайплайна ДО
// tier K/дублей/T1-T5. Возвращает { rows, remainingLegacyRows } — вторые
// идут дальше в обычное сопоставление.
async function applyOverrides(client, fullOverrides, legacyRows, copies, allCopies) {
  const byOldN = new Map(legacyRows.map((r) => [r.oldN, r]));
  const byNameNorm = new Map();
  for (const r of legacyRows) {
    if (!byNameNorm.has(r.nameNorm)) byNameNorm.set(r.nameNorm, []);
    byNameNorm.get(r.nameNorm).push(r);
  }
  // match_copy резолвится ТОЛЬКО среди active — сама архивирует копию, в
  // архивный слот "заходить" бессмысленно. place_next_to — среди ЛЮБОГО
  // статуса (allCopies) — копия остаётся на месте, читаются только её
  // parent_id/catalog_type/sbornik_id (не меняются архивацией), см.
  // buildOverridePlaceNextToRow.
  const copiesByNameNorm = new Map();
  for (const c of copies) {
    if (!copiesByNameNorm.has(c.nameNorm)) copiesByNameNorm.set(c.nameNorm, []);
    copiesByNameNorm.get(c.nameNorm).push(c);
  }
  const anyStatusCopiesByNameNorm = new Map();
  for (const c of allCopies) {
    if (!anyStatusCopiesByNameNorm.has(c.nameNorm)) anyStatusCopiesByNameNorm.set(c.nameNorm, []);
    anyStatusCopiesByNameNorm.get(c.nameNorm).push(c);
  }

  // Две строки поправок с одним и тем же old_n — почти наверняка ошибка
  // редактирования файла (правка задумывалась как ЗАМЕНА, а не добавление) —
  // вторая молча перезаписала бы решение первой (или дала бы дублирующую
  // строку плана на тот же legacy_id). Падаем сразу с понятным сообщением,
  // а не гадаем, какая из них "настоящая".
  const seenOldN = new Map();
  for (const ov of fullOverrides) {
    if (ov.old_n == null) continue;
    if (seenOldN.has(ov.old_n)) {
      throw new Error(
        `scripts/data/legacy_overrides.json: old_n=${ov.old_n} встречается больше одного раза среди строк ` +
          `с action (${seenOldN.get(ov.old_n)} и ${ov.action}) — это должна быть ЗАМЕНА, а не две строки. ` +
          `Уберите дубликат.`,
      );
    }
    seenOldN.set(ov.old_n, ov.action);
  }

  const handledIds = new Set();
  const rows = [];

  for (const ov of fullOverrides) {
    const overrideKey = ov.old_n != null ? String(ov.old_n) : (ov.name ?? "?");

    let legacyRow = null;
    let idError = null;
    if (ov.old_n != null) {
      legacyRow = byOldN.get(ov.old_n) ?? null;
      if (!legacyRow) idError = `legacy-строка с old_n=${ov.old_n} не найдена среди активных под корнем`;
    } else if (ov.name) {
      const norm = normalizeName(ov.name);
      const matches = byNameNorm.get(norm) ?? [];
      if (matches.length === 1) legacyRow = matches[0];
      else {
        idError =
          matches.length === 0
            ? `legacy-строка с именем "${ov.name}" не найдена`
            : `имя "${ov.name}" неоднозначно (${matches.length} строк: id=${matches.map((m) => m.id).join(",")})`;
      }
    } else {
      idError = "у строки поправки нет ни old_n, ни name";
    }

    if (idError) {
      rows.push(buildOverrideErrorRow(ov, idError, null, overrideKey));
      continue;
    }
    handledIds.add(legacyRow.id);

    if (ov.action === "archive") {
      rows.push(buildOverrideArchiveRow(legacyRow, ov, overrideKey));
      continue;
    }

    if (ov.action === "delete_if_unreferenced") {
      rows.push(await buildOverrideDeleteRow(client, legacyRow, ov, overrideKey));
      continue;
    }

    if (ov.action === "match_copy") {
      if (!ov.copy_name) {
        rows.push(buildOverrideErrorRow(ov, `action=match_copy требует copy_name`, legacyRow, overrideKey));
        continue;
      }
      const norm = normalizeName(ov.copy_name);
      const candidates = copiesByNameNorm.get(norm) ?? [];
      if (candidates.length !== 1) {
        rows.push(buildOverrideCopyAmbiguousRow(legacyRow, ov, candidates, overrideKey));
        continue;
      }
      rows.push(buildOverrideMatchCopyRow(legacyRow, candidates[0], ov, overrideKey));
      continue;
    }

    if (ov.action === "place_next_to") {
      if (!ov.copy_name) {
        rows.push(buildOverrideErrorRow(ov, `action=place_next_to требует copy_name`, legacyRow, overrideKey));
        continue;
      }
      const norm = normalizeName(ov.copy_name);
      const candidates = anyStatusCopiesByNameNorm.get(norm) ?? [];
      if (candidates.length !== 1) {
        rows.push(buildOverrideCopyAmbiguousRow(legacyRow, ov, candidates, overrideKey));
        continue;
      }
      const copy = candidates[0];
      if (copy.status === "archived" && copy.parentId == null) {
        rows.push(
          buildOverrideErrorRow(
            ov,
            `копия-якорь "${ov.copy_name}" (legacy_num=${copy.legacyNum}) архивна и без parent_id ` +
              `(родитель, видимо, удалён) — разместить рядом с ней невозможно`,
            legacyRow,
            overrideKey,
          ),
        );
        continue;
      }
      rows.push(buildOverridePlaceNextToRow(legacyRow, copy, ov, overrideKey));
      continue;
    }

    rows.push(buildOverrideErrorRow(ov, `неизвестный action="${ov.action}"`, legacyRow, overrideKey));
  }

  const remainingLegacyRows = legacyRows.filter((r) => !handledIds.has(r.id));
  return { rows, remainingLegacyRows };
}

// Поправки без action (только { old_n, set_unit?, set_price? }) — применяются
// ПОСЛЕ основного пайплайна поверх уже готовой move-строки (слот копии не
// меняется). Мутирует переданные rows на месте (override_unit/override_price).
const MOVE_FAMILY_ACTIONS = new Set(["move", "match_copy", "move_and_archive_twins"]);

function applyAdjustments(rows, adjustments) {
  const byOldN = new Map(rows.filter((r) => r.old_n != null).map((r) => [r.old_n, r]));
  const report = [];
  for (const adj of adjustments) {
    const row = adj.old_n != null ? byOldN.get(adj.old_n) : null;
    if (!row) {
      report.push({ adj, applied: false, reason: `строка с old_n=${adj.old_n} не найдена в плане` });
      continue;
    }
    if (!MOVE_FAMILY_ACTIONS.has(row.action)) {
      report.push({
        adj,
        row,
        applied: false,
        reason: `action=${row.action} (не move/match_copy/move_and_archive_twins) — поправка не применена`,
      });
      continue;
    }
    const before = { unit: row.override_unit ?? row.legacy_unit, price: row.override_price ?? row.legacy_price };
    if (adj.set_unit != null) row.override_unit = adj.set_unit;
    if (adj.set_price != null) row.override_price = adj.set_price;
    const after = { unit: row.override_unit ?? row.legacy_unit, price: row.override_price ?? row.legacy_price };
    report.push({ adj, row, applied: true, before, after });
  }
  return report;
}

// Двойное занятие копии: одна копия (по copy_legacy_num — портируемый ключ)
// не может достаться двум РАЗНЫМ legacy-строкам. Раньше это могло произойти
// молча: автоплан отдаёт копию одной строке, override match_copy/
// place_next_to — той же копии, но другой строке; вторая при --apply падала
// в "уже сделано" (копия archived) и просто оставалась под корнем без
// объяснений (это и случилось на staging со строкой 930). Здесь — явная
// проверка ПОСЛЕ сборки итогового плана, до отчёта/записи файлов:
//   - move/match_copy/move_and_archive_twins (сама копия + все близнецы) —
//     каждый copy_legacy_num должен встречаться максимум у одной строки;
//   - place_next_to сам по себе НЕ архивирует копию, поэтому две разные
//     place_next_to на одну копию — не конфликт (обе законно становятся её
//     соседями); но если тот же copy_legacy_num ТАКЖЕ архивируется другой
//     строкой (move/match_copy/twins) — это конфликт: копия, рядом с которой
//     должна была остаться place_next_to-строка, перестанет существовать
//     активной.
// Возвращает список конфликтов; buildPlan() и --apply останавливаются, если
// список не пуст (см. вызовы ниже).
function findDoubleClaimConflicts(rows) {
  const claims = new Map(); // legacyNum -> [row,...] (move/match_copy/twins, включая близнецов)
  const addClaim = (legacyNum, row) => {
    if (legacyNum == null) return;
    if (!claims.has(legacyNum)) claims.set(legacyNum, []);
    claims.get(legacyNum).push(row);
  };
  for (const row of rows) {
    if (row.action === "move" || row.action === "match_copy") {
      addClaim(row.copy_legacy_num, row);
    } else if (row.action === "move_and_archive_twins") {
      addClaim(row.copy_legacy_num, row);
      for (const t of row.twin_copy_legacy_nums ?? []) addClaim(t, row);
    }
  }
  // place_next_to НЕ архивирует и не "занимает" копию — она лишь читает
  // parent_id/catalog_type/sbornik_id снимком при построении плана
  // (buildOverridePlaceNextToRow) и на --apply использует этот снимок, не
  // обращаясь к текущему состоянию копии вовсе (см. resolvePlanRow/
  // runApply). Поэтому place_next_to принципиально не может участвовать в
  // двойном занятии — ни с другим place_next_to на ту же копию (оба законно
  // становятся её соседями), ни с move/match_copy/twins, которые эту же
  // копию архивируют (архивация не трогает читаемые place_next_to поля).
  const conflicts = [];
  for (const [legacyNum, claimants] of claims) {
    if (claimants.length > 1) conflicts.push({ copyLegacyNum: legacyNum, claimants });
  }
  return conflicts;
}

function describeDoubleClaimConflicts(conflicts) {
  return conflicts
    .map((c) => {
      const rowsDesc = c.claimants
        .map((r) => `legacy_id=${r.legacy_id} old_n=${r.old_n} action=${r.action} "${r.legacy_name}"`)
        .join(" И ");
      return `  copy_legacy_num=${c.copyLegacyNum}: ${rowsDesc}`;
    })
    .join("\n");
}

// node scripts/migrate-legacy-root.js --self-test — проверяет
// findDoubleClaimConflicts на фикстурах, без БД (нет ни pool.connect(), ни
// чтения .env) — можно гонять локально/в CI до всякого доступа к серверу.
// Минимальные строки-фикстуры содержат только поля, которые реально читает
// findDoubleClaimConflicts (action/copy_legacy_num/twin_copy_legacy_nums) +
// то, что использует describeDoubleClaimConflicts для сообщения об ошибке.
function selfTestRow(legacyId, action, copyLegacyNum, twins = []) {
  return {
    legacy_id: legacyId,
    old_n: legacyId,
    legacy_name: `тест-${legacyId}`,
    action,
    copy_legacy_num: copyLegacyNum,
    twin_copy_legacy_nums: twins,
  };
}

function runSelfTest() {
  const cases = [
    {
      name: "place_next_to + move на одну копию → OK (place_next_to не участвует в занятии копии)",
      rows: [selfTestRow(1, "place_next_to", 100), selfTestRow(2, "move", 100)],
      expectConflicts: 0,
    },
    {
      name: "два move на одну копию → ошибка",
      rows: [selfTestRow(3, "move", 200), selfTestRow(4, "move", 200)],
      expectConflicts: 1,
    },
    {
      name: "match_copy + move на одну копию → ошибка",
      rows: [selfTestRow(5, "match_copy", 300), selfTestRow(6, "move", 300)],
      expectConflicts: 1,
    },
    {
      name: "две place_next_to на одну копию → OK (обе законно становятся соседями)",
      rows: [selfTestRow(7, "place_next_to", 400), selfTestRow(8, "place_next_to", 400)],
      expectConflicts: 0,
    },
    // Дополнительно (не из ТЗ, но напрашивается): близнец move_and_archive_twins
    // конфликтует с move на ту же копию — twin_copy_legacy_nums тоже должны
    // проверяться, не только основной copy_legacy_num строки.
    {
      name: "move_and_archive_twins (близнец=500) + move на копию 500 → ошибка",
      rows: [selfTestRow(9, "move_and_archive_twins", 600, [500]), selfTestRow(10, "move", 500)],
      expectConflicts: 1,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const conflicts = findDoubleClaimConflicts(c.rows);
    const ok = conflicts.length === c.expectConflicts;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${c.name} (ожидалось конфликтов: ${c.expectConflicts}, получено: ${conflicts.length})`,
    );
    if (!ok) {
      failed++;
      if (conflicts.length) console.log(describeDoubleClaimConflicts(conflicts));
    }
  }

  if (failed) {
    console.error(`\nСамотест провален: ${failed} из ${cases.length}.`);
    process.exitCode = 1;
  } else {
    console.log(`\nСамотест пройден: ${cases.length} из ${cases.length}.`);
  }
}

// ---------------------------------------------------------------------------
// buildPlan
// ---------------------------------------------------------------------------

const RESOLVED_ACTIONS = new Set([
  "move",
  "match_copy",
  "move_and_archive_twins",
  "place_next_to",
  "archive",
  "delete_if_unreferenced",
  "merge_into_winner",
]);

export async function buildPlan(client) {
  await assertOldNColumn(client);
  const root = await loadRoot(client);
  const legacyRows = await loadLegacyRows(client, root.id);
  const archivedCount = await loadArchivedLegacyCount(client, root.id);
  // allCopies — любой статус (нужен place_next_to, см. loadCopyRows); copies —
  // только active, для T1-T5/tier K/match_copy (резолв в реально свободный слот).
  const allCopies = await loadCopyRows(client);
  const copies = allCopies.filter((c) => c.status === "active");
  const indices = buildCopyIndices(copies);

  const { fullOverrides, adjustments } = loadOverridesFile();
  const { rows: overrideRows, remainingLegacyRows } = await applyOverrides(
    client,
    fullOverrides,
    legacyRows,
    copies,
    allCopies,
  );

  const tierK = testTierKHypothesis(remainingLegacyRows, indices);

  const dupGroups = detectDuplicateGroups(remainingLegacyRows);
  const { loserIds, winnerOf, groupInfo } = resolveDuplicateWinners(dupGroups, indices);

  const subjects = remainingLegacyRows.filter((r) => !loserIds.has(r.id));
  const rawMatches = subjects.map((row) => ({ row, ...matchTiers(row, indices, copies, tierK.enabled) }));
  const resolvedMatches = resolveConflicts(rawMatches);

  const algoRows = resolvedMatches.map(buildRowFromMatch);
  const mergeRows = remainingLegacyRows.filter((r) => loserIds.has(r.id)).map((r) => buildMergeRow(r, winnerOf.get(r.id)));

  const rows = [...overrideRows, ...algoRows, ...mergeRows].sort((a, b) => a.legacy_id - b.legacy_id);

  const doubleClaimConflicts = findDoubleClaimConflicts(rows);
  if (doubleClaimConflicts.length) {
    throw new Error(
      `Обнаружено ${doubleClaimConflicts.length} случаев двойного занятия копии (одна копия нужна ` +
        `нескольким legacy-строкам) — построение плана остановлено, файлы CSV/JSON НЕ записаны:\n` +
        describeDoubleClaimConflicts(doubleClaimConflicts),
    );
  }

  const adjustmentReport = applyAdjustments(rows, adjustments);

  // record_items, которые будут перепривязаны С АРХИВИРУЕМЫХ КОПИЙ на
  // перенесённые legacy-строки (move/match_copy — сама копия; twins — слот
  // + все близнецы). Это НЕ то же самое, что "record_items" в сводке по
  // статусам (там — record_items самой legacy-строки, который никуда не
  // денется, т.к. id строки не меняется) — на staging было 0 (копии свежие,
  // ссылок на них ещё не завели), на проде может быть больше.
  const copyByLegacyNum = new Map(copies.map((c) => [c.legacyNum, c]));
  let recordItemsOnArchivedCopies = 0;
  for (const row of rows) {
    if (row.action === "move" || row.action === "match_copy") {
      recordItemsOnArchivedCopies += copyByLegacyNum.get(row.copy_legacy_num)?.recordItemsCount ?? 0;
    } else if (row.action === "move_and_archive_twins") {
      recordItemsOnArchivedCopies += copyByLegacyNum.get(row.copy_legacy_num)?.recordItemsCount ?? 0;
      for (const t of row.twin_copy_legacy_nums ?? []) {
        recordItemsOnArchivedCopies += copyByLegacyNum.get(t)?.recordItemsCount ?? 0;
      }
    }
  }

  const summary = new Map();
  for (const row of rows) {
    const s = summary.get(row.action) ?? { legacyRows: 0, recordItems: 0 };
    s.legacyRows++;
    s.recordItems += row.record_items;
    summary.set(row.action, s);
  }

  const tierBreakdown = new Map();
  for (const row of rows) {
    if (row.action !== "move") continue;
    tierBreakdown.set(row.tier, (tierBreakdown.get(row.tier) ?? 0) + 1);
  }

  const predictedRemaining = rows.filter((r) => !RESOLVED_ACTIONS.has(r.action)).length;

  return {
    generatedAt: new Date().toISOString(),
    rootId: root.id,
    rootName: root.name,
    archivedLegacyCount: archivedCount,
    totalActiveLegacy: legacyRows.length,
    totalCopies: copies.length,
    tierK,
    duplicateGroups: groupInfo,
    tierBreakdown: [...tierBreakdown.entries()],
    summary: [...summary.entries()],
    adjustmentReport,
    predictedRemaining,
    recordItemsOnArchivedCopies,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Отчёт в консоль (dry-run).
// ---------------------------------------------------------------------------

function printReport(plan) {
  console.log("--- Корень и исходные данные ---");
  console.log(`legacy_root: id=${plan.rootId} "${plan.rootName}"`);
  console.log(`Активных legacy-листьев под корнем: ${plan.totalActiveLegacy}`);
  console.log(`Архивных legacy-листьев под корнем (не трогаем): ${plan.archivedLegacyCount}`);
  console.log(`Кандидатов-копий (source=user_added, legacy_num IS NOT NULL, active): ${plan.totalCopies}`);

  console.log("\n--- Гипотеза tier K: old_n legacy-строки == legacy_num копии ---");
  console.log(
    `Однозначных (1:1) T1-пар: ${plan.tierK.pairs}, из них сравнимых (оба ключа не null): ${plan.tierK.comparable}, ` +
      `совпало: ${plan.tierK.equal} (${(plan.tierK.ratio * 100).toFixed(1)}%)`,
  );
  console.log(
    plan.tierK.enabled
      ? `Порог ${TIER_K_THRESHOLD * 100}% пройден — tier K ВКЛЮЧЁН (проверяется раньше T1).`
      : `Порог ${TIER_K_THRESHOLD * 100}% НЕ пройден — tier K игнорируется, используются только T1-T5.`,
  );

  console.log("\n--- Дубли имён среди legacy (вне поправок с action) ---");
  console.log(`Групп дублей: ${plan.duplicateGroups.length}`);
  for (const g of plan.duplicateGroups.slice(0, 10)) {
    console.log(`  "${g.nameNorm}": winner legacy_id=${g.winnerId}, losers legacy_id=${g.loserIds.join(",")}`);
  }
  if (plan.duplicateGroups.length > 10) console.log(`  ...и ещё ${plan.duplicateGroups.length - 10}`);

  console.log("\n--- Строки поправок (scripts/data/legacy_overrides.json, с action) ---");
  const overrideRows = plan.rows.filter((r) => r.override_key != null);
  if (!overrideRows.length) {
    console.log("  (нет)");
  }
  for (const r of overrideRows) {
    const target = r.copy_id ? `copy_id=${r.copy_id} legacy_num=${r.copy_legacy_num} "${r.copy_path}"` : "";
    console.log(`  key=${r.override_key} legacy_id=${r.legacy_id} "${r.legacy_name}" action=${r.action} ${target}`);
    console.log(`    ${r.notes}`);
  }

  console.log("\n--- Поправки к автоплану (без action, только set_unit/set_price) ---");
  if (!plan.adjustmentReport.length) {
    console.log("  (нет)");
  }
  for (const a of plan.adjustmentReport) {
    if (a.applied) {
      console.log(
        `  old_n=${a.adj.old_n} "${a.row.legacy_name}": unit ${a.before.unit} -> ${a.after.unit}, ` +
          `price ${a.before.price} -> ${a.after.price} (action=${a.row.action})`,
      );
    } else {
      console.log(`  old_n=${a.adj.old_n}: НЕ применена — ${a.reason}`);
    }
  }

  console.log("\n--- Сводка по статусам ---");
  for (const [status, s] of plan.summary) {
    console.log(`  ${status}: legacy-строк=${s.legacyRows}, record_items=${s.recordItems}`);
  }

  console.log("\n--- Разбивка автоплана (action=move) по тирам ---");
  for (const [tier, count] of plan.tierBreakdown) {
    console.log(`  ${tier}: ${count}`);
  }

  const conflicts = plan.rows.filter((r) => r.action === "conflict");
  if (conflicts.length) {
    console.log(`\n--- Примеры conflict (${conflicts.length} всего, показаны первые 10) ---`);
    for (const r of conflicts.slice(0, 10)) {
      console.log(`  legacy_id=${r.legacy_id} old_n=${r.old_n} "${r.legacy_name}" — ${r.notes}`);
    }
  }

  const suggestions = plan.rows.filter((r) => r.action === "suggestion");
  if (suggestions.length) {
    console.log(`\n--- Примеры suggestion (${suggestions.length} всего, показаны первые 10) ---`);
    for (const r of suggestions.slice(0, 10)) {
      console.log(`  legacy_id=${r.legacy_id} old_n=${r.old_n} "${r.legacy_name}" — ${r.notes}`);
    }
  }

  const manual = plan.rows.filter((r) => r.action === "manual");
  if (manual.length) {
    console.log(`\n--- Примеры manual (${manual.length} всего, показаны первые 10) ---`);
    for (const r of manual.slice(0, 10)) {
      console.log(`  legacy_id=${r.legacy_id} old_n=${r.old_n} "${r.legacy_name}"`);
    }
  }

  const unresolvedOverrides = plan.rows.filter((r) => r.action === "override_unresolved");
  if (unresolvedOverrides.length) {
    console.log(`\n--- override_unresolved (${unresolvedOverrides.length}) — требуют уточнения, см. выше ---`);
    for (const r of unresolvedOverrides) {
      console.log(`  key=${r.override_key} legacy_id=${r.legacy_id ?? "?"} — ${r.notes}`);
    }
  }

  console.log(
    `\nrecord_items, которые будут перепривязаны с архивируемых копий на перенесённые строки: ` +
      `${plan.recordItemsOnArchivedCopies}`,
  );

  console.log(
    `\n--- Итог: живых legacy-строк под корнем после применения плана (ожидается 0): ${plan.predictedRemaining} ---`,
  );

  console.log(`\nCSV: ${PLAN_CSV_PATH}`);
  console.log(`JSON: ${PLAN_JSON_PATH}`);
}

// ---------------------------------------------------------------------------
// CSV / JSON вывод.
// ---------------------------------------------------------------------------

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Столбцы — как в исходном ТЗ (legacy_id..notes), плюс copy_legacy_num и
// twin_copy_legacy_nums: без них план непортируем между staging/прод и
// неполон для близнецов (см. заголовок файла) — намеренное расширение
// списка столбцов, не отступление от него.
const CSV_COLUMNS = [
  "legacy_id", "old_n", "legacy_name", "legacy_unit", "legacy_price", "record_items",
  "tier", "copy_id", "copy_path", "copy_unit", "copy_price", "diff_flags", "action", "notes",
  "copy_legacy_num", "twin_copy_legacy_nums",
];

function csvValue(row, column) {
  if (column === "twin_copy_legacy_nums") return (row[column] ?? []).join("|");
  return row[column];
}

function writeCsv(rows, path) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(csvValue(row, c))).join(","));
  }
  fs.writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

// Ключ строки в JSON-плане — old_n, запасной legacy_id.
function planRowKey(row) {
  return row.old_n != null ? String(row.old_n) : `legacy:${row.legacy_id}`;
}

function writePlanJson(plan, path) {
  const rowsByKey = {};
  for (const row of plan.rows) {
    rowsByKey[planRowKey(row)] = row;
  }
  const payload = {
    generatedAt: plan.generatedAt,
    dbName: resolveDbName(),
    rootId: plan.rootId,
    tierKEnabled: plan.tierK.enabled,
    tierKRatio: plan.tierK.ratio,
    totalActiveLegacy: plan.totalActiveLegacy,
    totalCopies: plan.totalCopies,
    predictedRemaining: plan.predictedRemaining,
    recordItemsOnArchivedCopies: plan.recordItemsOnArchivedCopies,
    summary: Object.fromEntries(plan.summary),
    rows: rowsByKey,
  };
  fs.writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Apply: резолв строк плана в ЖИВЫЕ строки ТЕКУЩЕГО окружения по old_n/
// legacy_num (см. заголовок файла), исполнение, идемпотентность.
// ---------------------------------------------------------------------------

function loadPlanFile(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return { ...raw, rows: Object.values(raw.rows) };
}

// Резолвит live-строку legacy по old_n; при отсутствии old_n (или если по
// нему ничего не нашлось) — запасной ключ name+unit, но ТОЛЬКО если он даёт
// РОВНО одно совпадение — иначе строка считается нерезолвленной.
async function resolveLegacyRow(client, { oldN, name, unit }) {
  if (oldN != null) {
    const { rows } = await client.query(
      `SELECT id, parent_id, status FROM work_types WHERE old_n = $1 AND source = 'legacy' AND level = 5`,
      [oldN],
    );
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) return { error: `old_n=${oldN} неоднозначен (${rows.length} строк)` };
  }
  const { rows } = await client.query(
    `SELECT id, parent_id, status FROM work_types
      WHERE source = 'legacy' AND level = 5
        AND lower(btrim(name)) = lower(btrim($1)) AND lower(btrim(unit)) = lower(btrim($2))`,
    [name, unit],
  );
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: "не найдена ни по old_n, ни по name+unit" };
  return { error: `запасной ключ name+unit неоднозначен (${rows.length} строк)` };
}

async function resolveCopyByLegacyNum(client, legacyNum) {
  const { rows } = await client.query(
    `SELECT id, parent_id, sbornik_id, catalog_type, sort_order, name, variant_label, status, legacy_num
       FROM work_types WHERE source = 'user_added' AND legacy_num = $1`,
    [legacyNum],
  );
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `копия с legacy_num=${legacyNum} не найдена` };
  return { error: `legacy_num=${legacyNum} неоднозначен (${rows.length} копий)` };
}

// Предварительный резолв (без записи) — используется и в preview (--apply
// без --confirm), и как первый шаг runApply (--confirm). unit/price-
// override'ы едут вместе со строкой плана (row.override_unit/override_price) —
// отдельный файл поправок на apply уже не перечитывается.
async function resolvePlanRow(client, row) {
  if (row.action === "move" || row.action === "match_copy") {
    const legacy = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (legacy.error) return { row, kind: "move", error: legacy.error };
    const copy = await resolveCopyByLegacyNum(client, row.copy_legacy_num);
    if (copy.error) return { row, kind: "move", error: copy.error };
    return { row, kind: "move", legacy, copy };
  }
  if (row.action === "move_and_archive_twins") {
    const legacy = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (legacy.error) return { row, kind: "twins", error: legacy.error };
    const primary = await resolveCopyByLegacyNum(client, row.copy_legacy_num);
    if (primary.error) return { row, kind: "twins", error: `слот: ${primary.error}` };
    const twins = [];
    for (const legacyNum of row.twin_copy_legacy_nums ?? []) {
      const twin = await resolveCopyByLegacyNum(client, legacyNum);
      if (twin.error) return { row, kind: "twins", error: `близнец legacy_num=${legacyNum}: ${twin.error}` };
      twins.push(twin);
    }
    return { row, kind: "twins", legacy, primary, twins };
  }
  if (row.action === "place_next_to") {
    // Копия НЕ резолвится заново — parent_id/catalog_type/sbornik_id
    // заморожены в плане при его построении (anchor_*, см.
    // buildOverridePlaceNextToRow); обращаться к текущему состоянию копии
    // здесь не нужно и вредно (архивация другой строкой в этом же apply не
    // должна влиять на place_next_to, см. заголовок файла).
    const legacy = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (legacy.error) return { row, kind: "place_next_to", error: legacy.error };
    if (row.anchor_parent_id == null) {
      return {
        row,
        kind: "place_next_to",
        error: "в плане нет anchor_parent_id для place_next_to (план сгенерирован старой версией скрипта?)",
      };
    }
    return { row, kind: "place_next_to", legacy };
  }
  if (row.action === "archive") {
    const legacy = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (legacy.error) return { row, kind: "archive", error: legacy.error };
    return { row, kind: "archive", legacy };
  }
  if (row.action === "delete_if_unreferenced") {
    const legacy = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (legacy.error) return { row, kind: "delete_if_unreferenced", error: legacy.error };
    return { row, kind: "delete_if_unreferenced", legacy };
  }
  if (row.action === "merge_into_winner") {
    const loser = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (loser.error) return { row, kind: "merge", error: loser.error };
    const winner = await resolveLegacyRow(client, { oldN: row.winner_old_n, name: null, unit: null });
    if (winner.error) return { row, kind: "merge", error: `winner: ${winner.error}` };
    return { row, kind: "merge", loser, winner };
  }
  return { row, kind: "skip" };
}

async function previewApply(client, plan) {
  const byKind = { move: [], twins: [], place_next_to: [], archive: [], delete_if_unreferenced: [], merge: [], skip: [] };
  const errors = [];
  for (const row of plan.rows) {
    const resolved = await resolvePlanRow(client, row);
    if (resolved.error) {
      errors.push({ row, error: resolved.error });
      continue;
    }
    byKind[resolved.kind].push(resolved);
  }

  console.log("--- Предпросмотр apply (без --confirm — ничего не меняется) ---");
  console.log(`Строк в плане: ${plan.rows.length}`);
  console.log(`move/match_copy (резолвлены): ${byKind.move.length}`);
  console.log(`move_and_archive_twins (резолвлены): ${byKind.twins.length}`);
  console.log(`place_next_to (резолвлены): ${byKind.place_next_to.length}`);
  console.log(`archive (резолвлены): ${byKind.archive.length}`);
  console.log(`delete_if_unreferenced (резолвлены): ${byKind.delete_if_unreferenced.length}`);
  console.log(`merge_into_winner (резолвлены): ${byKind.merge.length}`);
  console.log(`conflict/suggestion/manual/override_unresolved (не трогаются): ${byKind.skip.length}`);
  if (errors.length) {
    console.log(`\nНЕ УДАЛОСЬ РЕЗОЛВИТЬ (${errors.length}) — --confirm их тоже пропустит и сообщит:`);
    for (const e of errors.slice(0, 20)) {
      console.log(`  legacy_id=${e.row.legacy_id} old_n=${e.row.old_n} action=${e.row.action}: ${e.error}`);
    }
    if (errors.length > 20) console.log(`  ...и ещё ${errors.length - 20}`);
  }
  console.log("\nЗапустите с --confirm, чтобы применить.");
}

// Общий UPDATE work_types для move/match_copy/twins (переезд листа в слот
// копии) — вынесен в функцию, т.к. используется и для обычного move, и для
// слота близнецов (move_and_archive_twins), различается только источником
// полей (copy vs primary) и legacy.id.
async function applyMoveUpdate(client, legacyId, copySnapshot, row) {
  const setParts = [
    "parent_id = $1", "level = 5", "catalog_type = $2", "sbornik_id = $3",
    "sort_order = $4", "name = $5", "variant_label = $6", "legacy_num = $7",
  ];
  const values = [
    copySnapshot.parent_id, copySnapshot.catalog_type, copySnapshot.sbornik_id,
    copySnapshot.sort_order, copySnapshot.name, copySnapshot.variant_label, copySnapshot.legacy_num,
  ];
  let idx = values.length + 1;
  if (row.override_unit != null) { setParts.push(`unit = $${idx}`); values.push(row.override_unit); idx++; }
  if (row.override_price != null) { setParts.push(`price = $${idx}`); values.push(row.override_price); idx++; }
  values.push(legacyId);
  await client.query(`UPDATE work_types SET ${setParts.join(", ")} WHERE id = $${idx}`, values);
}

async function archiveCopyAndRelink(client, legacyId, copyId) {
  const { rowCount } = await client.query(
    `UPDATE record_items SET work_type_id = $1 WHERE work_type_id = $2`,
    [legacyId, copyId],
  );
  await client.query(`UPDATE work_types SET status = 'archived', archived_at = now() WHERE id = $1`, [copyId]);
  return rowCount;
}

async function runApply(client, plan) {
  const counters = {
    moved: 0, copiesArchived: 0, recordItemsRelinked: 0, merged: 0,
    placedNextTo: 0, archivedOverride: 0, deleted: 0, archivedInsteadOfDeleted: 0,
    twinsMoved: 0, twinCopiesArchived: 0,
    alreadyDone: 0, unresolved: 0,
  };
  const unresolvedRows = [];

  await client.query("BEGIN");
  try {
    for (const row of plan.rows) {
      const resolved = await resolvePlanRow(client, row);
      if (resolved.error) {
        counters.unresolved++;
        unresolvedRows.push({ row, error: resolved.error });
        continue;
      }

      if (resolved.kind === "move") {
        const { legacy, copy } = resolved;
        if (copy.status === "archived") {
          counters.alreadyDone++;
          continue;
        }
        await applyMoveUpdate(client, legacy.id, copy, row);
        counters.recordItemsRelinked += await archiveCopyAndRelink(client, legacy.id, copy.id);
        counters.moved++;
        counters.copiesArchived++;
      } else if (resolved.kind === "twins") {
        const { legacy, primary, twins } = resolved;
        if (primary.status === "archived") {
          counters.alreadyDone++;
          continue;
        }
        await applyMoveUpdate(client, legacy.id, primary, row);
        counters.recordItemsRelinked += await archiveCopyAndRelink(client, legacy.id, primary.id);
        counters.copiesArchived++;
        for (const twin of twins) {
          if (twin.status === "archived") continue; // этот конкретный близнец уже обработан раньше
          counters.recordItemsRelinked += await archiveCopyAndRelink(client, legacy.id, twin.id);
          counters.twinCopiesArchived++;
        }
        counters.twinsMoved++;
      } else if (resolved.kind === "place_next_to") {
        const { legacy } = resolved;
        if (legacy.parent_id !== plan.rootId) {
          // Единственный способ, которым legacy-строка теряет parent_id=root, —
          // это уже выполненный шаг этого скрипта — копия для place_next_to
          // никогда не архивируется и вообще не резолвится заново здесь
          // (используется снимок row.anchor_*, см. resolvePlanRow), поэтому
          // это единственный и достаточный признак идемпотентности.
          counters.alreadyDone++;
          continue;
        }
        // sort_order — единственное поле, которое НЕ заморожено в плане:
        // пересчитывается заново от текущих соседей под anchor_parent_id
        // (могли появиться новые с момента dry-run).
        const { rows: maxRows } = await client.query(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM work_types WHERE parent_id = $1`,
          [row.anchor_parent_id],
        );
        const setParts = [
          "parent_id = $1", "level = 5", "catalog_type = $2", "sbornik_id = $3",
          "sort_order = $4", "variant_label = NULL",
        ];
        const values = [row.anchor_parent_id, row.anchor_catalog_type, row.anchor_sbornik_id, maxRows[0].next];
        let idx = values.length + 1;
        if (row.override_unit != null) { setParts.push(`unit = $${idx}`); values.push(row.override_unit); idx++; }
        if (row.override_price != null) { setParts.push(`price = $${idx}`); values.push(row.override_price); idx++; }
        values.push(legacy.id);
        await client.query(`UPDATE work_types SET ${setParts.join(", ")} WHERE id = $${idx}`, values);
        counters.placedNextTo++;
      } else if (resolved.kind === "archive") {
        const { legacy } = resolved;
        if (legacy.status === "archived") {
          counters.alreadyDone++;
          continue;
        }
        await client.query(`UPDATE work_types SET status = 'archived', archived_at = now() WHERE id = $1`, [legacy.id]);
        counters.archivedOverride++;
      } else if (resolved.kind === "delete_if_unreferenced") {
        const { legacy } = resolved;
        if (legacy.status === "archived") {
          counters.alreadyDone++;
          continue;
        }
        const refs = await countReferences(client, legacy.id);
        const total = refs.recordItemsCount + refs.childrenCount + refs.stepBaseRefsCount;
        if (total === 0) {
          await client.query(`DELETE FROM work_types WHERE id = $1`, [legacy.id]);
          counters.deleted++;
        } else {
          await client.query(`UPDATE work_types SET status = 'archived', archived_at = now() WHERE id = $1`, [legacy.id]);
          counters.archivedInsteadOfDeleted++;
          console.log(
            `  old_n=${row.old_n} legacy_id=${legacy.id}: есть ссылки (record_items=${refs.recordItemsCount}, ` +
              `children=${refs.childrenCount}, step_base_refs=${refs.stepBaseRefsCount}) — заархивирована вместо удаления`,
          );
        }
      } else if (resolved.kind === "merge") {
        const { loser, winner } = resolved;
        if (loser.status === "archived") {
          counters.alreadyDone++;
          continue;
        }
        counters.recordItemsRelinked += await archiveCopyAndRelink(client, winner.id, loser.id);
        counters.merged++;
      }
      // kind === "skip" (conflict/suggestion/manual/override_unresolved) — ничего не делаем.
    }

    const { rows: remainingRows } = await client.query(
      `SELECT count(*)::int AS cnt FROM work_types
        WHERE parent_id = $1 AND source = 'legacy' AND level = 5 AND status = 'active'`,
      [plan.rootId],
    );
    counters.remainingActiveUnderRoot = remainingRows[0].cnt;

    // Финальная проверка: план по замыслу должен свести живые legacy-строки
    // под корнем к 0 (все они либо move/match_copy/twins/place_next_to,
    // либо archive/delete_if_unreferenced/merge_into_winner — единственное,
    // что законно остаётся, это conflict/suggestion/manual/
    // override_unresolved, которые дорабатываются через overrides.json до
    // следующего прогона). Ненулевой остаток здесь — сигнал, что план не
    // готов к проду целиком: ЛУЧШЕ откатить всё и разобраться, чем оставить
    // БД в частично перенесённом состоянии.
    if (counters.remainingActiveUnderRoot > 0) {
      const { rows: leftover } = await client.query(
        `SELECT id, old_n, name FROM work_types
          WHERE parent_id = $1 AND source = 'legacy' AND level = 5 AND status = 'active'
          ORDER BY id`,
        [plan.rootId],
      );
      await client.query("ROLLBACK");
      console.log(
        `\n--- ROLLBACK: под корнем остались бы ${counters.remainingActiveUnderRoot} живых legacy-строк ` +
          `(ожидалось 0) — ВСЯ транзакция отменена, в БД ничего не изменилось ---`,
      );
      for (const r of leftover) {
        console.log(`  id=${r.id} old_n=${r.old_n} "${r.name}"`);
      }
      console.log(
        "\nЭто не то же самое, что просто conflict/suggestion/manual/override_unresolved — план в принципе " +
          "не сводится к 0. Доработайте scripts/data/legacy_overrides.json (см. секции выше и в --dry-run) " +
          "и запустите --apply --confirm заново.",
      );
      printApplyCounters(counters, unresolvedRows);
      return { ...counters, rolledBack: true };
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  console.log("--- Apply выполнен (COMMIT) ---");
  printApplyCounters(counters, unresolvedRows);
  return { ...counters, rolledBack: false };
}

function printApplyCounters(counters, unresolvedRows) {
  console.log(`Перенесено (move/match_copy): ${counters.moved}`);
  console.log(`Перенесено близнецами (move_and_archive_twins): ${counters.twinsMoved}`);
  console.log(`Копий заархивировано (move/match_copy/слот близнецов): ${counters.copiesArchived}`);
  console.log(`Доп. копий-близнецов заархивировано: ${counters.twinCopiesArchived}`);
  console.log(`Размещено рядом (place_next_to): ${counters.placedNextTo}`);
  console.log(`Заархивировано (override archive): ${counters.archivedOverride}`);
  console.log(`Удалено физически (delete_if_unreferenced): ${counters.deleted}`);
  console.log(`Заархивировано вместо удаления (были ссылки): ${counters.archivedInsteadOfDeleted}`);
  console.log(`record_items перепривязано: ${counters.recordItemsRelinked}`);
  console.log(`Дублей смёржено (merge_into_winner): ${counters.merged}`);
  console.log(`Уже было сделано раньше (пропущено идемпотентно): ${counters.alreadyDone}`);
  console.log(`Не удалось резолвить (пропущено, см. список): ${counters.unresolved}`);
  console.log(`Живых legacy-строк, оставшихся под корнем: ${counters.remainingActiveUnderRoot}`);
  if (unresolvedRows.length) {
    console.log("\nНерезолвленные строки:");
    for (const u of unresolvedRows.slice(0, 20)) {
      console.log(`  legacy_id=${u.row.legacy_id} old_n=${u.row.old_n} action=${u.row.action}: ${u.error}`);
    }
    if (unresolvedRows.length > 20) console.log(`  ...и ещё ${unresolvedRows.length - 20}`);
  }
  return counters;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { apply, confirm, planPath, selfTest } = parseArgs();

  if (selfTest) {
    runSelfTest();
    return;
  }

  if (!apply) {
    // Убираем старые файлы ДО построения плана — если buildPlan() бросит
    // исключение (например, двойное занятие копии), на диске не должно
    // остаться ни старого, ни полу-записанного плана, который можно
    // спутать со свежим (см. removeStalePlanFiles).
    removeStalePlanFiles();
    const client = await pool.connect();
    try {
      const plan = await buildPlan(client);
      printReport(plan);
      writeCsv(plan.rows, PLAN_CSV_PATH);
      writePlanJson(plan, PLAN_JSON_PATH);
    } finally {
      client.release();
    }
    return;
  }

  if (!planPath) {
    console.error("--apply требует --plan <путь к legacy_plan.json>.");
    process.exitCode = 1;
    return;
  }
  const plan = loadPlanFile(planPath);

  // Origin-проверка: план должен быть построен ИМЕННО для той БД, к которой
  // подключится этот прогон (.env в текущей директории) — иначе staging
  // легко спутать с прод и наоборот (id разные, но dbName должен различаться
  // всегда, т.к. .env.example требует явно задавать DB_NAME). Планы старых
  // версий скрипта (без dbName) тоже отклоняются — пересоздайте --dry-run.
  const currentDbName = resolveDbName();
  if (!plan.dbName) {
    console.error(
      "В plan.json нет поля dbName (план сгенерирован более старой версией скрипта) — " +
        "пересоздайте его свежим --dry-run на целевом окружении, прежде чем применять.",
    );
    process.exitCode = 1;
    return;
  }
  if (plan.dbName !== currentDbName) {
    console.error(
      `План построен для БД "${plan.dbName}", а текущее подключение (.env в этой директории) — ` +
        `"${currentDbName}". Похоже, план сгенерирован на другом окружении (staging/прод перепутаны) — ` +
        `apply остановлен, БД не тронута.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`План: dbName="${plan.dbName}", построен ${plan.generatedAt}.`);

  // Та же проверка двойного занятия копии, что и при построении плана
  // (buildPlan) — перевалидируем здесь на случай, если plan.json правили
  // руками или он был сгенерирован более старой версией скрипта. Ничего не
  // трогаем в БД, пока это не пройдено.
  const doubleClaimConflicts = findDoubleClaimConflicts(plan.rows);
  if (doubleClaimConflicts.length) {
    console.error(
      `Обнаружено ${doubleClaimConflicts.length} случаев двойного занятия копии в загруженном плане — ` +
        `apply остановлен, БД не тронута:`,
    );
    console.error(describeDoubleClaimConflicts(doubleClaimConflicts));
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    await assertOldNColumn(client);
    if (!confirm) {
      await previewApply(client, plan);
      return;
    }
    const result = await runApply(client, plan);
    if (result.rolledBack) process.exitCode = 1;
  } finally {
    client.release();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main()
    .catch((err) => {
      console.error("Скрипт упал с ошибкой:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}

/**
 * Примеры запуска (на сервере, из папки бэкенда — там же лежит .env):
 *
 *   node scripts/migrate-legacy-root.js --dry-run
 *   (флаг --dry-run опционален — это поведение по умолчанию без --apply)
 *
 *   node scripts/migrate-legacy-root.js --apply --plan /tmp/legacy_plan.json
 *     (без --confirm — только печатает, что будет сделано)
 *
 *   node scripts/migrate-legacy-root.js --apply --plan /tmp/legacy_plan.json --confirm
 *     (одна транзакция, реально переносит/архивирует/удаляет/перепривязывает)
 *
 * scripts/data/legacy_overrides.json — { "rows": [...] }, два вида строк
 * (см. подробный разбор в заголовке файла):
 *   - с action: match_copy | place_next_to | archive | delete_if_unreferenced
 *     — { old_n?, name?, action, copy_name?, set_unit?, set_price? };
 *     адресация legacy-строки — old_n, иначе точное совпадение name;
 *     адресация копии — copy_name (точное нормализованное совпадение; 0 или
 *     >1 совпадений — строка попадает в отчёт как override_unresolved со
 *     списком найденных вариантов, ничего не выбирается автоматически).
 *     match_copy ищет копию ТОЛЬКО среди active (сама архивирует её —
 *     в архивный слот "заходить" бессмысленно). place_next_to ищет среди
 *     ЛЮБОГО статуса (active и archived) и читает parent_id/catalog_type/
 *     sbornik_id копии ОДИН РАЗ при построении плана — эти поля не меняются
 *     архивацией, поэтому дальше place_next_to от статуса копии не зависит
 *     вообще (см. правило про двойное занятие ниже); если найденная копия
 *     уже архивна на момент построения плана и у неё нет parent_id — это
 *     единственный случай, когда place_next_to всё же падает в
 *     override_unresolved (разместить рядом буквально не с чем).
 *   - без action: { old_n, set_unit?, set_price? } — поправка ПОВЕРХ
 *     результата обычного автосопоставления (ожидается action=move/
 *     match_copy/move_and_archive_twins); если строка свелась к чему-то
 *     другому — поправка не применяется, это видно в отчёте
 *     ("Поправки к автоплану").
 *
 * Правило близнецов (move_and_archive_twins): несколько кандидатов-копий на
 * тирах K/T1-T4, но все с одинаковыми нормализованными name/unit/price И
 * одинаковым parent_id — не конфликт, а дублирующиеся строки одной позиции.
 * Слот — копия с минимальным id, остальные архивируются, их record_items
 * тоже перепривязываются на перенесённую строку.
 *
 * delete_if_unreferenced: на --apply проверяются ссылки на строку
 * (record_items.work_type_id, work_types.parent_id,
 * work_types.step_base_work_type_id — единственные FK на work_types(id),
 * requests вообще не ссылается). 0 ссылок — строка физически удаляется
 * (DELETE); есть ссылки — вместо удаления архивируется, с явным сообщением
 * в выводе. dry-run показывает то же самое предсказательно (не гарантирует
 * состояние на момент apply — между запусками БД может измениться).
 *
 * Идемпотентность --apply --confirm: каждая строка резолвится заново по
 * old_n/legacy_num — КРОМЕ place_next_to, которая копию вообще не
 * резолвит повторно (см. ниже). Признак "уже сделано в прошлый прогон" —
 * свой для каждого действия: для move/match_copy/слота близнецов — копия
 * уже archived; для place_next_to — parent_id legacy-строки уже не равен id
 * корня (единственный и достаточный признак — см. ниже, почему статус
 * копии тут ни при чём); для archive/delete_if_unreferenced — сама строка
 * уже archived; для merge_into_winner — проигравший уже archived. Строки,
 * которые не удалось резолвить, пропускаются с сообщением, не обрывая
 * транзакцию целиком.
 *
 * Двойное занятие копии (findDoubleClaimConflicts): проверяется ПОСЛЕ
 * сборки плана — и в --dry-run (buildPlan бросает исключение, CSV/JSON не
 * пишутся, а перед построением плана старые CSV/JSON вообще удаляются, см.
 * removeStalePlanFiles — свежий прогон не должен оставить после себя ничего,
 * что можно принять за актуальный план), и заново в --apply (main()
 * проверяет уже загруженный plan.json перед BEGIN — на случай ручной правки
 * файла или более старого dry-run). Одна копия (по copy_legacy_num) не
 * может архивироваться двумя разными строками (move/match_copy/twins,
 * включая каждого близнеца) — это единственная проверка, place_next_to в
 * ней НЕ участвует вообще: она не архивирует копию и читает только
 * parent_id/catalog_type/sbornik_id (не меняются архивацией) ОДИН РАЗ при
 * построении плана, замораживая их в саму строку плана (anchor_parent_id/
 * anchor_catalog_type/anchor_sbornik_id, см. buildOverridePlaceNextToRow) —
 * на --apply используются эти замороженные значения напрямую, копия не
 * резолвится заново ни по имени, ни по legacy_num, и её текущий статус
 * (архивирована ли она к этому моменту другой строкой того же плана) роли
 * не играет. (Раньше здесь была ошибочная перекрёстная проверка
 * place_next_to против move/match_copy/twins — она давала ложные
 * срабатывания именно в этом законном случае и была убрана.)
 *
 * Самотест без БД: node scripts/migrate-legacy-root.js --self-test —
 * проверяет findDoubleClaimConflicts на фикстурах (без pool.connect()).
 *
 * Финальная проверка --apply --confirm: в конце (до COMMIT) считаются живые
 * legacy-строки, оставшиеся под корнем. По замыслу их должно быть 0 (все,
 * что не move/match_copy/twins/place_next_to/archive/
 * delete_if_unreferenced/merge_into_winner, — это conflict/suggestion/
 * manual/override_unresolved, которые не должны доходить до --apply
 * недоработанными). Если остаток не 0 — ROLLBACK ВСЕЙ транзакции (ничего не
 * коммитится, даже успешно обработанные строки этого прогона), список
 * оставшихся строк (id/old_n/name) печатается, а сам скрипт завершается с
 * process.exitCode=1.
 *
 * Origin-проверка --apply: plan.json несёт dbName (то же значение, что и
 * process.env.DB_NAME || "uchet_db" на момент dry-run) и generatedAt. Перед
 * любым обращением к БД --apply сверяет dbName плана с dbName текущего
 * подключения (.env в текущей директории) — несовпадение (или отсутствие
 * dbName — план от старой версии скрипта) останавливает apply без единого
 * запроса к БД. Это защита именно от "применили план staging на проде (или
 * наоборот)", а не от давности плана самой по себе — generatedAt печатается
 * для информации, но не проверяется на "свежесть" по таймауту.
 *
 * Что скрипт НЕ трогает: legacy_root (сам корень), 3 архивные legacy-строки
 * (загружаются только status='active'), is_step_item/is_counter_step/
 * step_base_work_type_id/step_unit_label ни у листа, ни у копии, requests.
 * source старой строки остаётся 'legacy' (кроме delete_if_unreferenced,
 * когда строка удаляется физически) — плоский список мастеров и бейдж
 * «Наш» (source IN ('legacy','manual'), см. directories.js) продолжают
 * работать как раньше.
 */
