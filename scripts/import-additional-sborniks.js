// Разовый импорт двух новых сборников (ГЭСН26 "Теплоизоляционные работы" и
// ГЭСНм08 "Электротехнические устройства", монтажные работы) в дерево
// work_types (level 1-5), поверх уже существующего каталога ГЭСН
// (source='gesn_catalog', см. import-gesn-catalog.js). По образцу этого
// скрипта, но:
//   - флаги --dry-run/--apply (не --dry-run/--force, как в оригинале);
//   - идемпотентность по (gesn_code листа, тот же сборник уровня 1) — не по
//     голому gesn_code (уникален только внутри своей книги, см. JSDoc п.5);
//     совпадение под ЭТИМ ЖЕ сборником не пропускается, а переподвешивается
//     (обновляются parent_id и содержательные поля, id не трогается — см.
//     JSDoc п.6, случай частичного среза ГЭСНм08 id=980);
//   - уровни 1-4 резолвятся через getOrCreateContainer/getOrCreateLevel1 по
//     (parent_id, level, name) / (level=1, gesn_code) — так безопасно
//     перезапускать --apply повторно; существующий level=1 переименовывается
//     в полное официальное название, если отличается.
//
// Требует миграцию 025 (sbornik_id + составной уникальный индекс
// (sbornik_id, gesn_code) вместо глобального) — каждая вставленная/
// переподвешенная строка получает sbornik_id = id её level=1. Без миграции
// 025 совпадение gesn_code с ДРУГИМ сборником (см. JSDoc п.5) упадёт на
// старом глобальном уникальном индексе.
//
// Формат входных файлов и обоснование решений по неоднозначным местам —
// см. JSDoc внизу файла.
import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const CATALOG_TYPE = "новое строительство";

const SBORNIKI = [
  {
    file: fileURLToPath(new URL("./data/gesn26_flat.json", import.meta.url)),
    key: "gesn26",
    gesnCode: "ГЭСН26",
    level1Name: "Теплоизоляционные работы",
    // gesn26_flat.json: раздел + подраздел (подраздел может быть пуст).
    level2Name: (item) => {
      const razdel = item["раздел"];
      const podrazdel = item["подраздел"];
      return podrazdel && podrazdel.trim() ? `${razdel}: ${podrazdel}` : razdel;
    },
  },
  {
    file: fileURLToPath(new URL("./data/gesnm08_flat.json", import.meta.url)),
    key: "gesnm08",
    gesnCode: "ГЭСНм08",
    level1Name: "Электротехнические устройства (монтажные работы)",
    // gesnm08_flat.json: отдел + раздел, отдел присутствует всегда.
    level2Name: (item) => `${item["отдел"]}: ${item["раздел"]}`,
  },
];

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

// Резолвер узлов дерева уровней 1-4 поверх кэшей — в dry-run режиме ничего
// не пишет в БД (фиктивные отрицательные id), в apply — реально создаёт
// строки внутри уже открытой транзакции. Контейнеры ищутся по (parent_id,
// level, name) перед созданием — повторный прогон не плодит дубликаты.
function createResolver(client, { dryRun }) {
  const containerCache = new Map(); // "parentId|level|name" -> id
  const sortCounters = new Map(); // parentId (или "level1") -> следующий sort_order
  let nextFakeId = -1;
  const created = { 1: [], 2: [], 3: [], 4: [] };
  const renames = []; // { id, oldName, newName } — существующий level=1 переименован под официальное название

  async function nextSortOrder(scopeKey, whereSql, whereParams) {
    if (!sortCounters.has(scopeKey)) {
      const { rows } = await client.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM work_types WHERE ${whereSql}`,
        whereParams,
      );
      sortCounters.set(scopeKey, Number(rows[0].next));
    }
    const n = sortCounters.get(scopeKey);
    sortCounters.set(scopeKey, n + 1);
    return n;
  }

  async function getOrCreateLevel1({ gesnCode, name }) {
    const key = `1|${gesnCode}`;
    if (containerCache.has(key)) return containerCache.get(key);

    const { rows } = await client.query(
      "SELECT id, name FROM work_types WHERE level = 1 AND gesn_code = $1",
      [gesnCode],
    );
    if (rows.length) {
      const existing = rows[0];
      containerCache.set(key, existing.id);
      // Может уже существовать как частичный срез той же официальной книги
      // (см. JSDoc, пункт 6) — переименовываем в полное официальное
      // название, id и остальные узлы не трогаем.
      if (existing.name !== name) {
        renames.push({ id: existing.id, oldName: existing.name, newName: name });
        if (!dryRun) {
          await client.query("UPDATE work_types SET name = $1 WHERE id = $2", [name, existing.id]);
        }
      }
      return existing.id;
    }

    if (dryRun) {
      const id = nextFakeId--;
      containerCache.set(key, id);
      created[1].push({ name, gesnCode });
      return id;
    }

    const sortOrder = await nextSortOrder("level1", "level = 1 AND parent_id IS NULL", []);
    const { rows: inserted } = await client.query(
      `INSERT INTO work_types
         (name, unit, price, level, parent_id, catalog_type, gesn_code, source, sort_order, has_price)
       VALUES ($1,'-',0,1,NULL,$2,$3,'gesn_catalog',$4,false)
       RETURNING id`,
      [name, CATALOG_TYPE, gesnCode, sortOrder],
    );
    const newId = inserted[0].id;
    // sbornik_id для level=1 — собственный id (миграция 025); недоступен на
    // момент INSERT (id даёт только сама вставка) — отдельный UPDATE сразу после.
    await client.query("UPDATE work_types SET sbornik_id = $1 WHERE id = $1", [newId]);
    containerCache.set(key, newId);
    created[1].push({ name, gesnCode });
    return newId;
  }

  async function getOrCreateContainer({ parentId, level, name, sbornikId }) {
    const key = `${parentId}|${level}|${name}`;
    if (containerCache.has(key)) return containerCache.get(key);

    const { rows } = await client.query(
      "SELECT id FROM work_types WHERE parent_id = $1 AND level = $2 AND name = $3",
      [parentId, level, name],
    );
    if (rows.length) {
      containerCache.set(key, rows[0].id);
      return rows[0].id;
    }

    if (dryRun) {
      const id = nextFakeId--;
      containerCache.set(key, id);
      created[level].push({ name, parentId });
      return id;
    }

    const sortOrder = await nextSortOrder(parentId, "parent_id = $1", [parentId]);
    const { rows: inserted } = await client.query(
      `INSERT INTO work_types
         (name, unit, price, level, parent_id, catalog_type, source, sort_order, has_price, sbornik_id)
       VALUES ($1,'-',0,$2,$3,$4,'gesn_catalog',$5,false,$6)
       RETURNING id`,
      [name, level, parentId, CATALOG_TYPE, sortOrder, sbornikId],
    );
    containerCache.set(key, inserted[0].id);
    created[level].push({ name, parentId });
    return inserted[0].id;
  }

  return { getOrCreateLevel1, getOrCreateContainer, created, renames };
}

// Строит план для одного сборника: резолвит/создаёт уровни 1-4, собирает
// список листьев (level=5) к вставке, пропуская коды, уже присутствующие в
// work_types. Возвращает отчёт для printReport + toInsertLeaves для вставки.
async function buildSbornikPlan(client, config, { dryRun }) {
  const items = JSON.parse(fs.readFileSync(config.file, "utf8"));
  const resolver = createResolver(client, { dryRun });

  const level1Id = await resolver.getOrCreateLevel1({
    gesnCode: config.gesnCode,
    name: config.level1Name,
  });

  // Идемпотентность — по паре (gesn_code листа, тот же сборник уровня 1),
  // а НЕ по голому gesn_code: коды ГЭСН уникальны только внутри своей книги
  // (см. миграция 025 — уникальный индекс теперь (sbornik_id, gesn_code),
  // раньше был глобальным, см. JSDoc п.5). Совпадение gesn_code под ЧУЖИМ
  // сборником больше не проблема для вставки — фильтруем прямо в SQL,
  // оставляя только совпадения под НАШИМ level1Id (кандидаты на переподвес).
  //
  // Подняться от листа к его сборнику НЕЛЬЗЯ фиксированным JOIN на 4 уровня
  // вверх: часть уже существующих листьев (см. JSDoc, пункт 6 — частичный
  // срез ГЭСНм08, id=980) висит ПЛОСКО прямо под level=2, без level=3/4.
  // Поэтому поднимаемся рекурсивным CTE по parent_id до узла без родителя
  // (level=1) — работает для любой глубины.
  const codes = items.map((it) => it["код"]);
  const { rows: matchRows } = codes.length
    ? await client.query(
        `WITH RECURSIVE ancestry AS (
           SELECT w.id AS leaf_id, w.parent_id AS leaf_parent_id, w.gesn_code,
                  w.id AS cur_id, w.parent_id AS cur_parent_id
             FROM work_types w
            WHERE w.level = 5 AND w.gesn_code = ANY($1)
           UNION ALL
           SELECT a.leaf_id, a.leaf_parent_id, a.gesn_code, p.id AS cur_id, p.parent_id AS cur_parent_id
             FROM ancestry a
             JOIN work_types p ON p.id = a.cur_parent_id
         )
         SELECT leaf_id, leaf_parent_id, gesn_code
           FROM ancestry
          WHERE cur_parent_id IS NULL AND cur_id = $2`,
        [codes, level1Id],
      )
    : { rows: [] };

  const ownBookMatches = new Map(); // gesn_code -> { leafId, leafParentId } — тот же сборник, переподвешиваем
  for (const row of matchRows) {
    ownBookMatches.set(row.gesn_code, { leafId: row.leaf_id, leafParentId: row.leaf_parent_id });
  }

  const toInsertLeaves = [];
  const relinks = []; // существующие листья того же сборника — обновляем parent_id + поля, id не трогаем
  const examples = [];
  let materialsDropped = 0;
  // Таблицы, где несколько РАЗНЫХ позиций делят одну пустую "группу" — имя
  // такой группы берётся от первой встреченной позиции (см. JSDoc внизу
  // файла), поэтому для остальных детей название группы не будет точным.
  // Собираем для отчёта, чтобы можно было проверить/переименовать вручную.
  const emptyGroupTables = new Map(); // l3Key -> { tableName, items: [код,...] }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const l2Name = config.level2Name(item);
    const l2Id = await resolver.getOrCreateContainer({ parentId: level1Id, level: 2, name: l2Name, sbornikId: level1Id });

    const l3Name = item["таблица"];
    const l3Id = await resolver.getOrCreateContainer({ parentId: l2Id, level: 3, name: l3Name, sbornikId: level1Id });

    const rawGroup = item["группа"] || "";
    const isEmptyGroup = !rawGroup.trim();
    const l4Name = isEmptyGroup ? item["вариант"] || item["наименование"] : rawGroup;
    const l4Id = await resolver.getOrCreateContainer({ parentId: l3Id, level: 4, name: l4Name, sbornikId: level1Id });

    if (isEmptyGroup) {
      const l3Key = `${l2Id}|${l3Name}`;
      if (!emptyGroupTables.has(l3Key)) {
        emptyGroupTables.set(l3Key, { tableName: l3Name, codes: [] });
      }
      emptyGroupTables.get(l3Key).codes.push(item["код"]);
    }

    materialsDropped += Array.isArray(item["материалы"]) ? item["материалы"].length : 0;

    const composition = Array.isArray(item["состав_работ"])
      ? item["состав_работ"].join("\n")
      : item["состав_работ"] || null;
    const variantLabel = item["вариант"] && item["вариант"].trim() ? item["вариант"] : item["наименование"];
    const price = Number(item["цена"]) || 0;

    // Уже существует под ЭТИМ ЖЕ сборником (найдено рекурсивным подъёмом
    // выше) — не создаём вторую строку с тем же gesn_code, а переподвешиваем
    // существующий лист на правильное место новой иерархии. id и внешние
    // ссылки (record_items) не трогаем — обновляем только parent_id и
    // содержательные поля.
    const ownMatch = ownBookMatches.get(item["код"]);
    if (ownMatch) {
      relinks.push({
        leafId: ownMatch.leafId,
        oldParentId: ownMatch.leafParentId,
        newParentId: l4Id,
        sbornikId: level1Id,
        code: item["код"],
        name: item["наименование"],
        unit: item["ед_изм"],
        laborHours: item["трудозатраты_чел_ч"],
        workComposition: composition,
        variantLabel,
        price,
        hasPrice: price > 0,
        sortOrder: i,
      });
      continue;
    }

    toInsertLeaves.push({
      parentId: l4Id,
      sbornikId: level1Id,
      gesnCode: item["код"],
      name: item["наименование"],
      unit: item["ед_изм"],
      laborHours: item["трудозатраты_чел_ч"],
      workComposition: composition,
      variantLabel,
      price,
      hasPrice: price > 0,
      sortOrder: i,
    });

    if (examples.length < 8) {
      examples.push({ code: item["код"], path: [config.level1Name, l2Name, l3Name, l4Name, item["наименование"]] });
    }
  }

  const multiItemEmptyGroups = [...emptyGroupTables.values()].filter((g) => g.codes.length > 1);

  // Переподвешивание (см. JSDoc п.6) двигает лист на НОВОЕ parent_id — старый
  // родитель (в частичном срезе ГЭСНм08 это плоский level=2) может остаться
  // без единого ребёнка. Это не переносится/не удаляется автоматически
  // (удаление — отдельное решение), но стоит явно показать в отчёте, чтобы
  // такие пустые ветки не всплыли в каталоге незамеченными.
  const oldParentIds = [...new Set(relinks.filter((r) => r.oldParentId !== r.newParentId).map((r) => r.oldParentId))];
  let orphanedContainers = [];
  if (oldParentIds.length) {
    const { rows: childCountRows } = await client.query(
      "SELECT parent_id, name, level, COUNT(*)::int AS total_children FROM work_types WHERE parent_id = ANY($1) GROUP BY parent_id, name, level",
      [oldParentIds],
    );
    const relinkedAwayCount = new Map();
    for (const r of relinks) {
      if (r.oldParentId === r.newParentId) continue;
      relinkedAwayCount.set(r.oldParentId, (relinkedAwayCount.get(r.oldParentId) || 0) + 1);
    }
    orphanedContainers = childCountRows
      .filter((row) => row.total_children === (relinkedAwayCount.get(row.parent_id) || 0))
      .map((row) => ({ id: row.parent_id, name: row.name, level: row.level }));
  }

  return {
    key: config.key,
    gesnCode: config.gesnCode,
    level1Id,
    totalItems: items.length,
    materialsDropped,
    toInsertLeaves,
    relinks,
    examples,
    created: resolver.created,
    renames: resolver.renames,
    multiItemEmptyGroups,
    orphanedContainers,
  };
}

function printPlanReport(plan) {
  console.log(`\n=== ${plan.gesnCode} (${plan.key}) ===`);
  console.log(`Позиций в файле: ${plan.totalItems}`);

  if (plan.renames.length) {
    for (const r of plan.renames) {
      console.log(`Переименован существующий сборник level=1 id=${r.id}: "${r.oldName}" -> "${r.newName}"`);
    }
  }

  console.log(
    `Переподвешено (лист уже существовал под этим сборником — было в другом месте дерева, ` +
      `теперь в правильной иерархии; id и внешние ссылки не менялись): ${plan.relinks.length}`,
  );
  console.log(`Новых листьев (level=5) к вставке: ${plan.toInsertLeaves.length}`);
  console.log(`Новых узлов level=2 (разделы): ${plan.created[2].length}`);
  console.log(`Новых узлов level=3 (таблицы): ${plan.created[3].length}`);
  console.log(`Новых узлов level=4 (группы): ${plan.created[4].length}`);
  console.log(`Полей "материалы" в файле (НЕ импортируются, колонки нет): ${plan.materialsDropped}`);

  if (plan.relinks.length) {
    console.log("\nПримеры переподвешенных листьев:");
    for (const r of plan.relinks.slice(0, 10)) {
      console.log(`  ${r.code} "${r.name}": parent_id ${r.oldParentId} -> ${r.newParentId} (id листа не менялся: ${r.leafId})`);
    }
    if (plan.relinks.length > 10) {
      console.log(`  ...и ещё ${plan.relinks.length - 10}`);
    }
  }

  if (plan.orphanedContainers.length) {
    console.log(
      `\nВНИМАНИЕ: узлы, которые после переподвешивания останутся БЕЗ единого ребёнка ` +
        `(старые контейнеры частичного среза — автоматически не удаляются, решение по ним отдельное):`,
    );
    for (const o of plan.orphanedContainers) {
      console.log(`  level=${o.level} id=${o.id} "${o.name}"`);
    }
  }

  if (plan.multiItemEmptyGroups.length) {
    console.log(
      `\nТаблицы, где несколько разных позиций делят одну пустую "группу" (имя группы = наименование ` +
        `первой позиции, остальные названы приблизительно — стоит проверить вручную): ${plan.multiItemEmptyGroups.length}`,
    );
    for (const g of plan.multiItemEmptyGroups.slice(0, 10)) {
      console.log(`  таблица "${g.tableName}": коды ${g.codes.join(", ")}`);
    }
    if (plan.multiItemEmptyGroups.length > 10) {
      console.log(`  ...и ещё ${plan.multiItemEmptyGroups.length - 10}`);
    }
  }

  console.log("\nПримеры путей:");
  for (const ex of plan.examples) {
    console.log(`  ${ex.code}: ${ex.path.join(" → ")}`);
  }
}

async function batchInsertLeaves(client, leaves, batchSize = 500) {
  const columns = [
    "name",
    "unit",
    "price",
    "level",
    "parent_id",
    "catalog_type",
    "gesn_code",
    "labor_hours",
    "work_composition",
    "is_step_item",
    "sort_order",
    "source",
    "has_price",
    "variant_label",
    "sbornik_id",
  ];
  let inserted = 0;
  for (let offset = 0; offset < leaves.length; offset += batchSize) {
    const chunk = leaves.slice(offset, offset + batchSize);
    const valuesSql = [];
    const params = [];
    chunk.forEach((leaf, i) => {
      const row = [
        leaf.name,
        leaf.unit,
        leaf.price,
        5,
        leaf.parentId,
        CATALOG_TYPE,
        leaf.gesnCode,
        leaf.laborHours,
        leaf.workComposition,
        false, // is_step_item — см. JSDoc внизу файла: в этих двух файлах нет
        // полей "доп_позиция"/"базовая_норма", по которым исходный
        // import-gesn-catalog.js определял шаговые позиции, детектировать
        // нечем.
        leaf.sortOrder,
        "gesn_catalog",
        leaf.hasPrice,
        leaf.variantLabel,
        leaf.sbornikId,
      ];
      const placeholders = columns.map((_, colIdx) => `$${i * columns.length + colIdx + 1}`);
      valuesSql.push(`(${placeholders.join(",")})`);
      params.push(...row);
    });
    const sql = `INSERT INTO work_types (${columns.join(",")}) VALUES ${valuesSql.join(",")}`;
    const { rowCount } = await client.query(sql, params);
    inserted += rowCount;
  }
  return inserted;
}

// Переподвешивает уже существующие листья (найдены тем же gesn_code под тем
// же сборником, но в другом месте дерева — см. JSDoc, пункт 6) на новое
// parent_id и обновляет содержательные поля. id, gesn_code, level,
// catalog_type, source и is_step_item/is_counter_step/step_* НЕ трогаем —
// на них могут ссылаться record_items или ручная разметка, сделанная раньше.
async function applyRelinks(client, relinks) {
  let updated = 0;
  for (const r of relinks) {
    await client.query(
      `UPDATE work_types
          SET parent_id = $1, name = $2, unit = $3, price = $4, has_price = $5,
              labor_hours = $6, work_composition = $7, variant_label = $8, sort_order = $9,
              sbornik_id = $10
        WHERE id = $11`,
      [
        r.newParentId,
        r.name,
        r.unit,
        r.price,
        r.hasPrice,
        r.laborHours,
        r.workComposition,
        r.variantLabel,
        r.sortOrder,
        r.sbornikId,
        r.leafId,
      ],
    );
    updated++;
  }
  return updated;
}

function parseArgs() {
  const rest = process.argv.slice(2);
  const only = rest.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  return {
    dryRun: rest.includes("--dry-run"),
    apply: rest.includes("--apply"),
    only,
  };
}

async function main() {
  const { dryRun, apply, only } = parseArgs();
  if (!dryRun && !apply) {
    console.error("Укажите --dry-run (посмотреть план) или --apply (выполнить вставку). Опционально --only=gesn26|gesnm08.");
    process.exitCode = 1;
    return;
  }

  const configs = only ? SBORNIKI.filter((s) => s.key === only) : SBORNIKI;
  if (!configs.length) {
    console.error(`Неизвестный --only=${only}. Ожидается одно из: ${SBORNIKI.map((s) => s.key).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    if (dryRun) {
      console.log("--- Dry-run: запись в БД не производится ---");
      for (const config of configs) {
        const plan = await buildSbornikPlan(client, config, { dryRun: true });
        printPlanReport(plan);
      }
      return;
    }

    await client.query("BEGIN");
    let totalInserted = 0;
    let totalRelinked = 0;
    for (const config of configs) {
      const plan = await buildSbornikPlan(client, config, { dryRun: false });
      printPlanReport(plan);
      const inserted = await batchInsertLeaves(client, plan.toInsertLeaves);
      const relinked = await applyRelinks(client, plan.relinks);
      totalInserted += inserted;
      totalRelinked += relinked;
    }
    console.log(`\n=== Итог ===`);
    console.log(`Вставлено новых листьев: ${totalInserted}`);
    console.log(`Переподвешено существующих листьев (тот же сборник, новое parent_id): ${totalRelinked}`);
    await client.query("COMMIT");
    console.log("COMMIT выполнен.");
  } catch (err) {
    if (apply) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Импорт упал с ошибкой:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

/**
 * Формат входных файлов: scripts/data/gesn26_flat.json,
 * scripts/data/gesnm08_flat.json — плоский массив объектов вида
 *   { код, раздел, подраздел, таблица, группа, вариант, наименование,
 *     ед_изм, трудозатраты_чел_ч, состав_работ[], материалы[],
 *     цена_база_2000, индекс, цена }
 * (gesnm08 вместо "подраздел" имеет "отдел" — уровень выше "раздела", а не
 * ниже, см. SBORNIKI[].level2Name).
 *
 * Примеры запуска (на сервере, из папки бэкенда — там же лежит .env):
 *
 *   node scripts/import-additional-sborniks.js --dry-run
 *   node scripts/import-additional-sborniks.js --dry-run --only=gesn26
 *   node scripts/import-additional-sborniks.js --apply
 *
 * Идемпотентность: --apply безопасно перезапускать. Совпадающий gesn_code
 * ПОД ТЕМ ЖЕ сборником уровня 1 (не голый gesn_code — коды ГЭСН уникальны
 * только внутри своей книги, см. пункт 5 ниже) не создаёт вторую строку, а
 * переподвешивает существующий лист (обновляет parent_id и содержательные
 * поля, id не трогает — см. пункт 6); узлы level=1-4 ищутся по (parent_id,
 * level, name) / (level=1, gesn_code) перед созданием, существующий level=1
 * при необходимости переименовывается в актуальное официальное название.
 *
 * Решения по неоднозначным местам ТЗ (проверить перед --apply на проде):
 *
 * 1. "материалы" — в схеме work_types НЕТ отдельной колонки под этот массив
 *    (в справочнике хранится только work_composition, см. миграции 017-024).
 *    Поле НЕ импортируется, не теряя данные молча — количество отброшенных
 *    записей "материалы" по каждому сборнику печатается в отчёте
 *    (materialsDropped). Добавлять колонку без обсуждения не стал.
 *
 * 2. "состав_работ" — во входных файлах это массив строк, но колонка
 *    work_composition — TEXT (одна строка на весь состав работ). Исходный
 *    файл, из которого был сделан ПЕРВЫЙ импорт (12291 строка,
 *    import-gesn-catalog.js), в репозитории не сохранился — сверить точный
 *    формат склейки по нему не удалось. Здесь массив сохраняется как
 *    join("\n") — по одному пункту состава работ на строку. Стоит сверить
 *    визуально на staging (открыть карточку любой существующей позиции с
 *    непустым work_composition и сравнить со свежеимпортированной) перед
 *    тем как переносить в прод.
 *
 * 3. is_step_item / step_base_work_type_id / is_counter_step — в оригинале
 *    (import-gesn-catalog.js) is_step_item брался из явного булева поля
 *    исходных данных "доп_позиция", а BASE_NORM_CODE_RE — это регэксп по
 *    ТЕКСТУ поля "базовая_норма" (не по gesn_code) для линковки уже
 *    помеченных доп-позиций к их базовой норме. Ни "доп_позиция", ни
 *    "базовая_норма" в gesn26_flat.json/gesnm08_flat.json не присутствуют —
 *    определить эти позиции автоматически нечем. Поэтому здесь для ВСЕХ
 *    строк обоих сборников: is_step_item=false, step_base_work_type_id=NULL,
 *    is_counter_step=false (последнее и так требовалось оставить как есть).
 *    Если по этим двум сборникам шаговые позиции всё же нужны — это отдельный
 *    этап ручной разметки поверх уже импортированных данных.
 *
 * 4. level=4 (группа) для позиций с пустой "группой": по ТЗ используется
 *    наименование/вариант позиции. Если внутри одной таблицы НЕСКОЛЬКО
 *    РАЗНЫХ позиций делят одну и ту же пустую "группу" (это не редкость —
 *    23 таких случая в ГЭСН26, 35 в ГЭСНм08), группа называется по ПЕРВОЙ
 *    встреченной позиции — остальные её дети получат не вполне точное имя
 *    родительской группы. Список таких таблиц печатается в отчёте
 *    (multiItemEmptyGroups) для ручной проверки/переименования после
 *    импорта, аналогично тому, как было с миграциями 021/023 для основного
 *    каталога.
 *
 * 5. gesn_code коллизии МЕЖДУ сборниками (ИСТОРИЯ, решено миграцией 025) —
 *    найдено на staging: "08-01-001-01" уже существует под ГЭСН08
 *    ("Конструкции из кирпича и блоков"), а в ГЭСНм08 тот же "код" — это
 *    "Трансформатор трёхфазный...", совершенно другая позиция. Разные книги
 *    (ГЭСН/ГЭСНм) переиспользуют один и тот же номер книги (08), и "код" в
 *    исходных файлах не несёт признака буквы книги. work_types раньше имел
 *    ГЛОБАЛЬНЫЙ уникальный индекс на gesn_code (idx_work_types_gesn_code,
 *    миграция 017) — такие коды физически нельзя было вставить, скрипт их
 *    детектировал и пропускал (codeConflicts) как отдельную категорию.
 *    Миграция 025 добавила sbornik_id и заменила индекс на составной
 *    UNIQUE (sbornik_id, gesn_code) WHERE gesn_code IS NOT NULL — коды
 *    теперь уникальны только внутри своей книги, как и должно быть по
 *    правилам ГЭСН. codeConflicts/crossBookConflicts убраны из скрипта:
 *    межкнижное совпадение gesn_code для вставки нового листа больше не
 *    проблема вообще — единственная причина не вставлять лист как новый —
 *    это совпадение gesn_code ПОД ЭТИМ ЖЕ сборником (см. пункт 6, релинк).
 *
 * 6. ГЭСНм08 частично уже существовал в базе (найдено на staging): level=1
 *    id=980, gesn_code='ГЭСНм08', до фикса называвшийся "Электротехнические
 *    установки (жилой срез)" — срез той же официальной книги на 290 листьев
 *    (только разделы 2.6/2.8/3.5 из более раннего импорта), с ПЛОСКОЙ
 *    структурой: листья висели прямо под level=2, без level=3 (таблица) и
 *    level=4 (группа). 1 запись в record_items ссылается на один из этих
 *    290 work_type_id — физически пересоздавать их id нельзя.
 *    Скрипт для этого id: (а) переименовывает его в актуальное название
 *    SBORNIKI[].level1Name, id не трогая; (б) для каждого листа файла,
 *    который уже существует под этим сборником (найдено рекурсивным
 *    подъёмом по parent_id — не фиксированным JOIN, т.к. глубина у старых
 *    записей другая), ОБНОВЛЯЕТ parent_id на правильный узел level=4 новой
 *    иерархии и обновляет содержательные поля (name/unit/price/has_price/
 *    labor_hours/work_composition/variant_label/sort_order), id и все
 *    остальные колонки (в т.ч. is_step_item/is_counter_step/step_*) не
 *    трогает. Такие случаи попадают в отчёт как "переподвешено", а не как
 *    "уже импортировано, пропускаем" — это осмысленное изменение дерева, а
 *    не no-op.
 *    Побочный эффект: старые плоские level=2 контейнеры частичного среза
 *    могут остаться без единого ребёнка, если новая иерархия для этих же
 *    позиций строит level=2/3/4 под другими именами. Скрипт их НЕ удаляет
 *    (удаление — отдельное решение), но печатает в отчёте (orphanedContainers)
 *    для ручной проверки.
 */
