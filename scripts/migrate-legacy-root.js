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
//   - копия резолвится по её legacy_num (миграция 024, уникален в паре
//     с source='user_added' на практике — если это не так, скрипт упадёт на
//     дубликате при резолве, см. resolveCopyByLegacyNum).
// Оба ключа стабильны между окружениями (в отличие от id), поэтому план,
// сформированный на staging, в принципе применим и на проде — план просто
// нужно СГЕНЕРИРОВАТЬ ЗАНОВО (--dry-run) на целевом окружении: набор
// legacy/copy строк и их old_n/legacy_num там свои.
//
// old_n — колонка из старого Flask-приложения (UNIQUE), для строк,
// перенесённых при миграции на текущий бэкенд. Ни один файл в migrations/
// её не создаёт — предположительно часть базовой схемы до появления
// schema_migrations (миграция 001). Скрипт проверяет её наличие через
// information_schema перед началом работы и падает с понятным сообщением,
// если её вдруг нет — вместо непонятной ошибки Postgres на первом запросе.
import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const PLAN_CSV_PATH = "/tmp/legacy_plan.csv";
const PLAN_JSON_PATH = "/tmp/legacy_plan.json";

// Порог для гипотезы "old_n старой строки равен legacy_num её копии"
// (см. testTierKHypothesis). На staging (2-й раунд диагностики) гипотеза НЕ
// подтвердилась (совпало 8 из 773) — с 90%-порогом tier K там будет
// автоматически отключён. Порог, а не жёстко "выключено", — чтобы скрипт
// остался рабочим, если на другом окружении (или после исправления данных)
// ключ вдруг всё-таки совпадёт почти всегда.
const TIER_K_THRESHOLD = 0.9;

// Синонимы единиц измерения — нижний регистр, без точек/пробелов (сначала
// applyUnitStrip, потом поиск в этой таблице). Список собран по частым
// вариантам написания в конструкторских сметах; для единиц вне списка
// используется просто lower+strip без канонизации (см. normalizeUnit).
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
    overridesPath: getOpt("--overrides"),
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
        "(колонка из старого Flask-приложения, УНИКАЛЬНАЯ, использовалась для сопоставления " +
        "перенесённых строк) — без неё резолв старых строк между окружениями не сработает как задумано. " +
        "Если колонки действительно нет — сообщите, нужно менять стратегию идентификации.",
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
async function loadCopyAncestors(client) {
  const { rows } = await client.query(
    `WITH RECURSIVE anc AS (
       SELECT leaf.id AS leaf_id, p.id, p.parent_id, p.level, p.name
         FROM work_types leaf
         JOIN work_types p ON p.id = leaf.parent_id
        WHERE leaf.source = 'user_added' AND leaf.legacy_num IS NOT NULL AND leaf.status = 'active'
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

async function loadCopyRows(client) {
  const { rows } = await client.query(
    `SELECT u.id, u.legacy_num, u.name, u.unit, u.price, u.parent_id, u.sbornik_id, u.catalog_type,
            u.sort_order, u.variant_label, p.name AS parent_name,
            COALESCE(ri.cnt, 0)::int AS record_items_count
       FROM work_types u
       LEFT JOIN work_types p ON p.id = u.parent_id
       LEFT JOIN (
         SELECT work_type_id, count(*) AS cnt FROM record_items GROUP BY work_type_id
       ) ri ON ri.work_type_id = u.id
      WHERE u.source = 'user_added' AND u.legacy_num IS NOT NULL AND u.status = 'active'
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

// ---------------------------------------------------------------------------
// Индексы + сопоставление (T1-T5, tier K).
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
// tier K, и определением победителя среди дублей имён (п.5 ТЗ).
function findT1Matches(legacyRow, indices) {
  const nameMatches = indices.byNameNorm.get(legacyRow.nameNorm) ?? [];
  return nameMatches.filter((c) => c.unitNorm === legacyRow.unitNorm && pricesEqual(c.price, legacyRow.price));
}

// Гипотеза: old_n совпадает с legacy_num КОПИИ среди уже однозначных (1:1)
// T1-пар. Если совпадает почти всегда (>= TIER_K_THRESHOLD) — old_n можно
// использовать как основной ключ сопоставления (tier K, проверяется раньше
// T1); иначе игнорируем гипотезу целиком (примерно так и вышло на staging:
// 8 из 773, см. заголовок файла).
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

// Дубли имён среди legacy (п.5 ТЗ): группы строк с одинаковым nameNorm.
function detectDuplicateGroups(legacyRows) {
  const byName = new Map();
  for (const row of legacyRows) {
    if (!byName.has(row.nameNorm)) byName.set(row.nameNorm, []);
    byName.get(row.nameNorm).push(row);
  }
  return [...byName.values()].filter((rows) => rows.length > 1);
}

// Победитель — тот, у кого unit+price совпадают с копией (T1); при равенстве
// (оба или ни один не имеют T1-совпадения) — больше record_items; при
// равенстве — меньший id. Проигравшие исключаются из обычного T1-T5
// сопоставления (не претендуют ни на одну копию) — вместо этого получают
// action=merge_into_winner.
function resolveDuplicateWinners(groups, indices) {
  const loserIds = new Set();
  const winnerOf = new Map(); // loserId -> winner row
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

// Возвращает { tier, candidates } — candidates.length === 1 на тирах
// K/T1-T4 значит "однозначно, можно строить автоплан" (после глобальной
// проверки конфликтов, см. resolveConflicts); T5 — только подсказки, никогда
// не автоплан, даже если кандидат ровно один.
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
// строкам. Считаются только тиры K/T1-T4 (T5 никогда не автоплан, поэтому в
// претензии на копию не участвует).
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
      const notes = m.suggestions
        .map((s) => `id=${s.copy.id}(score=${s.score}) ${s.copy.path}`)
        .join(" | ");
      return { ...m, status: "suggestion", notes: `подсказки (не автоплан): ${notes}` };
    }
    if (m.candidates.length > 1) {
      const ids = m.candidates.map((c) => c.id).join(",");
      return { ...m, status: "conflict", notes: `тир ${m.tier}: несколько кандидатов copy_id=${ids}` };
    }
    const cid = m.candidates[0].id;
    const contenders = claims.get(cid);
    if (contenders.length > 1) {
      const others = contenders.filter((id) => id !== m.row.id);
      return {
        ...m,
        status: "conflict",
        notes: `copy_id=${cid} также запрошена legacy_id=${others.join(",")}`,
      };
    }
    return { ...m, status: "move", notes: `тир ${m.tier}` };
  });
}

// ---------------------------------------------------------------------------
// Сборка строк отчёта (общий формат для CSV/JSON — JSON несёт дополнительные
// машиночитаемые поля, которых нет в CSV, см. заголовок файла).
// ---------------------------------------------------------------------------

function computeDiffFlags(legacyRow, candidate) {
  if (!candidate) return "";
  const flags = [];
  if (!pricesEqual(legacyRow.price, candidate.price)) flags.push("price_diff");
  if (legacyRow.unitNorm !== candidate.unitNorm) flags.push("unit_diff");
  return flags.join(";");
}

function buildRowFromMatch(m) {
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
    winner_old_n: null,
    winner_legacy_id: null,
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
    winner_old_n: winnerRow.oldN,
    winner_legacy_id: winnerRow.id,
  };
}

export async function buildPlan(client) {
  await assertOldNColumn(client);
  const root = await loadRoot(client);
  const legacyRows = await loadLegacyRows(client, root.id);
  const archivedCount = await loadArchivedLegacyCount(client, root.id);
  const copies = await loadCopyRows(client);
  const indices = buildCopyIndices(copies);

  const tierK = testTierKHypothesis(legacyRows, indices);

  const dupGroups = detectDuplicateGroups(legacyRows);
  const { loserIds, winnerOf, groupInfo } = resolveDuplicateWinners(dupGroups, indices);

  const subjects = legacyRows.filter((r) => !loserIds.has(r.id));
  const rawMatches = subjects.map((row) => ({ row, ...matchTiers(row, indices, copies, tierK.enabled) }));
  const resolvedMatches = resolveConflicts(rawMatches);

  const moveOrOtherRows = resolvedMatches.map(buildRowFromMatch);
  const mergeRows = legacyRows.filter((r) => loserIds.has(r.id)).map((r) => buildMergeRow(r, winnerOf.get(r.id)));

  const rows = [...moveOrOtherRows, ...mergeRows].sort((a, b) => a.legacy_id - b.legacy_id);

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

  console.log("\n--- Дубли имён среди legacy ---");
  console.log(`Групп дублей: ${plan.duplicateGroups.length}`);
  for (const g of plan.duplicateGroups.slice(0, 10)) {
    console.log(`  "${g.nameNorm}": winner legacy_id=${g.winnerId}, losers legacy_id=${g.loserIds.join(",")}`);
  }
  if (plan.duplicateGroups.length > 10) console.log(`  ...и ещё ${plan.duplicateGroups.length - 10}`);

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

// Столбцы — как в ТЗ (legacy_id..notes), плюс copy_legacy_num в конце: без
// него план непортируем между staging/прод (см. заголовок файла) — это
// намеренное расширение списка столбцов, не отступление от него.
const CSV_COLUMNS = [
  "legacy_id", "old_n", "legacy_name", "legacy_unit", "legacy_price", "record_items",
  "tier", "copy_id", "copy_path", "copy_unit", "copy_price", "diff_flags", "action", "notes",
  "copy_legacy_num",
];

function writeCsv(rows, path) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(row[c])).join(","));
  }
  fs.writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

// Ключ строки в JSON-плане — old_n, запасной legacy_id (см. заголовок файла
// про портируемость между окружениями).
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
    rootId: plan.rootId,
    tierKEnabled: plan.tierK.enabled,
    tierKRatio: plan.tierK.ratio,
    totalActiveLegacy: plan.totalActiveLegacy,
    totalCopies: plan.totalCopies,
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

function loadOverrides(path) {
  if (!path) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

// Резолвит live-строку legacy по old_n; при отсутствии old_n (или если по
// нему ничего не нашлось) — запасной ключ name+unit (без учёта регистра/
// пробелов), но ТОЛЬКО если он даёт РОВНО одно совпадение — иначе строка
// считается нерезолвленной (лучше пропустить и сообщить, чем угадать не ту).
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
// без --confirm), и как первый шаг runApply (--confirm).
async function resolvePlanRow(client, row, overrides) {
  if (row.action === "move") {
    const legacy = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (legacy.error) return { row, kind: "move", error: legacy.error };
    const copy = await resolveCopyByLegacyNum(client, row.copy_legacy_num);
    if (copy.error) return { row, kind: "move", error: copy.error };
    const override = overrides[planRowKey(row)] ?? {};
    return { row, kind: "move", legacy, copy, override };
  }
  if (row.action === "merge_into_winner") {
    const loser = await resolveLegacyRow(client, { oldN: row.old_n, name: row.legacy_name, unit: row.legacy_unit });
    if (loser.error) return { row, kind: "merge", error: loser.error };
    const winner = await resolveLegacyRow(client, {
      oldN: row.winner_old_n,
      name: null,
      unit: null,
    });
    if (winner.error) return { row, kind: "merge", error: `winner: ${winner.error}` };
    return { row, kind: "merge", loser, winner };
  }
  return { row, kind: "skip" };
}

async function previewApply(client, plan, overrides) {
  const byKind = { move: [], merge: [], skip: [] };
  const errors = [];
  for (const row of plan.rows) {
    const resolved = await resolvePlanRow(client, row, overrides);
    if (resolved.error) {
      errors.push({ row, error: resolved.error });
      continue;
    }
    byKind[resolved.kind].push(resolved);
  }

  console.log("--- Предпросмотр apply (без --confirm — ничего не меняется) ---");
  console.log(`Строк в плане: ${plan.rows.length}`);
  console.log(`move (резолвлены, будут перенесены): ${byKind.move.length}`);
  console.log(`merge_into_winner (резолвлены): ${byKind.merge.length}`);
  console.log(`conflict/suggestion/manual (не трогаются): ${byKind.skip.length}`);
  if (errors.length) {
    console.log(`\nНЕ УДАЛОСЬ РЕЗОЛВИТЬ (${errors.length}) — --confirm их тоже пропустит и сообщит:`);
    for (const e of errors.slice(0, 20)) {
      console.log(`  legacy_id=${e.row.legacy_id} old_n=${e.row.old_n} action=${e.row.action}: ${e.error}`);
    }
    if (errors.length > 20) console.log(`  ...и ещё ${errors.length - 20}`);
  }
  console.log("\nЗапустите с --confirm, чтобы применить.");
}

async function runApply(client, plan, overrides) {
  const counters = { moved: 0, copiesArchived: 0, recordItemsRelinked: 0, merged: 0, alreadyDone: 0, unresolved: 0 };
  const unresolvedRows = [];

  await client.query("BEGIN");
  try {
    for (const row of plan.rows) {
      const resolved = await resolvePlanRow(client, row, overrides);
      if (resolved.error) {
        counters.unresolved++;
        unresolvedRows.push({ row, error: resolved.error });
        continue;
      }

      if (resolved.kind === "move") {
        const { legacy, copy, override } = resolved;
        if (copy.status === "archived") {
          // Уже перенесено в прошлый прогон (копия архивируется последним
          // шагом move — см. ниже) — идемпотентно пропускаем.
          counters.alreadyDone++;
          continue;
        }

        const setParts = [
          "parent_id = $1", "level = 5", "catalog_type = $2", "sbornik_id = $3",
          "sort_order = $4", "name = $5", "variant_label = $6", "legacy_num = $7",
        ];
        const values = [
          copy.parent_id, copy.catalog_type, copy.sbornik_id,
          copy.sort_order, copy.name, copy.variant_label, copy.legacy_num,
        ];
        let idx = values.length + 1;
        if (override.unit != null) { setParts.push(`unit = $${idx}`); values.push(override.unit); idx++; }
        if (override.price != null) { setParts.push(`price = $${idx}`); values.push(override.price); idx++; }
        values.push(legacy.id);

        await client.query(`UPDATE work_types SET ${setParts.join(", ")} WHERE id = $${idx}`, values);

        const { rowCount } = await client.query(
          `UPDATE record_items SET work_type_id = $1 WHERE work_type_id = $2`,
          [legacy.id, copy.id],
        );
        counters.recordItemsRelinked += rowCount;

        await client.query(
          `UPDATE work_types SET status = 'archived', archived_at = now() WHERE id = $1`,
          [copy.id],
        );

        counters.moved++;
        counters.copiesArchived++;
      } else if (resolved.kind === "merge") {
        const { loser, winner } = resolved;
        if (loser.status === "archived") {
          counters.alreadyDone++;
          continue;
        }
        const { rowCount } = await client.query(
          `UPDATE record_items SET work_type_id = $1 WHERE work_type_id = $2`,
          [winner.id, loser.id],
        );
        counters.recordItemsRelinked += rowCount;

        await client.query(
          `UPDATE work_types SET status = 'archived', archived_at = now() WHERE id = $1`,
          [loser.id],
        );
        counters.merged++;
      }
      // kind === "skip" (conflict/suggestion/manual) — ничего не делаем.
    }

    const { rows: remainingRows } = await client.query(
      `SELECT count(*)::int AS cnt FROM work_types
        WHERE parent_id = $1 AND source = 'legacy' AND level = 5 AND status = 'active'`,
      [plan.rootId],
    );
    counters.remainingActiveUnderRoot = remainingRows[0].cnt;

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  console.log("--- Apply выполнен (COMMIT) ---");
  console.log(`Перенесено legacy-строк: ${counters.moved}`);
  console.log(`Копий заархивировано: ${counters.copiesArchived}`);
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
  const { apply, confirm, planPath, overridesPath } = parseArgs();

  if (!apply) {
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
  const overrides = loadOverrides(overridesPath);

  const client = await pool.connect();
  try {
    await assertOldNColumn(client);
    if (!confirm) {
      await previewApply(client, plan, overrides);
      return;
    }
    await runApply(client, plan, overrides);
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
 *   (флаг --dry-run опционален — это поведение по умолчанию без --apply;
 *   можно передавать явно, скрипт его просто игнорирует отдельно от
 *   проверки "нет --apply")
 *
 *   node scripts/migrate-legacy-root.js --apply --plan /tmp/legacy_plan.json
 *     (без --confirm — только печатает, что будет сделано)
 *
 *   node scripts/migrate-legacy-root.js --apply --plan /tmp/legacy_plan.json --confirm
 *     (одна транзакция, реально переносит/архивирует/перепривязывает)
 *
 *   node scripts/migrate-legacy-root.js --apply --plan /tmp/legacy_plan.json \
 *     --overrides /tmp/legacy_overrides.json --confirm
 *
 * overrides.json — { "<old_n или legacy:<id>>": { "unit": "...", "price": 123 } }
 * (тот же ключ, что в legacy_plan.json — см. planRowKey). Переопределяет
 * unit/price ТОЛЬКО для action=move — на остальные действия не влияет.
 *
 * Идемпотентность --apply --confirm: перед переносом каждая строка резолвится
 * заново по old_n/legacy_num (см. заголовок файла); если копия конкретной
 * move-строки уже в статусе archived — перенос этой строки был выполнен в
 * прошлый прогон, шаг пропускается (alreadyDone), сообщается в итоге, СБОЙ
 * не считается. Аналогично для merge_into_winner — по статусу проигравшего.
 * Строки, которые не удалось резолвить (например, if old_n/legacy_num не
 * нашлись в этом окружении), пропускаются с сообщением, не обрывая
 * транзакцию целиком — остальные строки применяются.
 *
 * Что скрипт НЕ трогает: legacy_root (сам корень), 3 архивные legacy-строки
 * (загружаются только status='active'), is_step_item/is_counter_step/
 * step_base_work_type_id/step_unit_label ни у листа, ни у копии, requests
 * (вообще не ссылается на work_types — проверено в раунде 2 диагностики).
 * source старой строки остаётся 'legacy' — плоский список мастеров и бейдж
 * «Наш» (см. workTypesRouter.listWhere в directories.js — source IN
 * ('legacy','manual')) продолжают работать как раньше.
 */
