// Разовый импорт двух новых сборников (ГЭСН26 "Теплоизоляционные работы" и
// ГЭСНм08 "Электротехнические устройства", монтажные работы) в дерево
// work_types (level 1-5), поверх уже существующего каталога ГЭСН
// (source='gesn_catalog', см. import-gesn-catalog.js). По образцу этого
// скрипта, но:
//   - флаги --dry-run/--apply (не --dry-run/--force, как в оригинале);
//   - идемпотентность по gesn_code на уровне листа (level=5): если строка
//     с таким gesn_code уже есть — пропускаем именно её, остальное дерево
//     (уровни 1-4) резолвится через getOrCreateContainer по (parent_id,
//     level, name) — так безопасно перезапускать --apply повторно.
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
      "SELECT id FROM work_types WHERE level = 1 AND gesn_code = $1",
      [gesnCode],
    );
    if (rows.length) {
      containerCache.set(key, rows[0].id);
      return rows[0].id;
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
    containerCache.set(key, inserted[0].id);
    created[1].push({ name, gesnCode });
    return inserted[0].id;
  }

  async function getOrCreateContainer({ parentId, level, name }) {
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
         (name, unit, price, level, parent_id, catalog_type, source, sort_order, has_price)
       VALUES ($1,'-',0,$2,$3,$4,'gesn_catalog',$5,false)
       RETURNING id`,
      [name, level, parentId, CATALOG_TYPE, sortOrder],
    );
    containerCache.set(key, inserted[0].id);
    created[level].push({ name, parentId });
    return inserted[0].id;
  }

  return { getOrCreateLevel1, getOrCreateContainer, created };
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

  const codes = items.map((it) => it["код"]);
  const { rows: existingRows } = codes.length
    ? await client.query("SELECT gesn_code FROM work_types WHERE gesn_code = ANY($1)", [codes])
    : { rows: [] };
  const existingCodes = new Set(existingRows.map((r) => r.gesn_code));

  const toInsertLeaves = [];
  const examples = [];
  let skippedExisting = 0;
  let materialsDropped = 0;
  // Таблицы, где несколько РАЗНЫХ позиций делят одну пустую "группу" — имя
  // такой группы берётся от первой встреченной позиции (см. JSDoc внизу
  // файла), поэтому для остальных детей название группы не будет точным.
  // Собираем для отчёта, чтобы можно было проверить/переименовать вручную.
  const emptyGroupTables = new Map(); // l3Key -> { tableName, items: [код,...] }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const l2Name = config.level2Name(item);
    const l2Id = await resolver.getOrCreateContainer({ parentId: level1Id, level: 2, name: l2Name });

    const l3Name = item["таблица"];
    const l3Id = await resolver.getOrCreateContainer({ parentId: l2Id, level: 3, name: l3Name });

    const rawGroup = item["группа"] || "";
    const isEmptyGroup = !rawGroup.trim();
    const l4Name = isEmptyGroup ? item["вариант"] || item["наименование"] : rawGroup;
    const l4Id = await resolver.getOrCreateContainer({ parentId: l3Id, level: 4, name: l4Name });

    if (isEmptyGroup) {
      const l3Key = `${l2Id}|${l3Name}`;
      if (!emptyGroupTables.has(l3Key)) {
        emptyGroupTables.set(l3Key, { tableName: l3Name, codes: [] });
      }
      emptyGroupTables.get(l3Key).codes.push(item["код"]);
    }

    materialsDropped += Array.isArray(item["материалы"]) ? item["материалы"].length : 0;

    if (existingCodes.has(item["код"])) {
      skippedExisting++;
      continue;
    }

    const composition = Array.isArray(item["состав_работ"])
      ? item["состав_работ"].join("\n")
      : item["состав_работ"] || null;
    const variantLabel = item["вариант"] && item["вариант"].trim() ? item["вариант"] : item["наименование"];
    const price = Number(item["цена"]) || 0;

    toInsertLeaves.push({
      parentId: l4Id,
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

  return {
    key: config.key,
    gesnCode: config.gesnCode,
    level1Id,
    totalItems: items.length,
    skippedExisting,
    materialsDropped,
    toInsertLeaves,
    examples,
    created: resolver.created,
    multiItemEmptyGroups,
  };
}

function printPlanReport(plan) {
  console.log(`\n=== ${plan.gesnCode} (${plan.key}) ===`);
  console.log(`Позиций в файле: ${plan.totalItems}`);
  console.log(`Уже импортировано ранее (найдено по gesn_code, пропускаем): ${plan.skippedExisting}`);
  console.log(`Новых листьев (level=5) к вставке: ${plan.toInsertLeaves.length}`);
  console.log(`Новых узлов level=2 (разделы): ${plan.created[2].length}`);
  console.log(`Новых узлов level=3 (таблицы): ${plan.created[3].length}`);
  console.log(`Новых узлов level=4 (группы): ${plan.created[4].length}`);
  console.log(`Полей "материалы" в файле (НЕ импортируются, колонки нет): ${plan.materialsDropped}`);

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
    let totalSkipped = 0;
    for (const config of configs) {
      const plan = await buildSbornikPlan(client, config, { dryRun: false });
      printPlanReport(plan);
      const inserted = await batchInsertLeaves(client, plan.toInsertLeaves);
      totalInserted += inserted;
      totalSkipped += plan.skippedExisting;
    }
    console.log(`\n=== Итог ===`);
    console.log(`Вставлено новых листьев: ${totalInserted}`);
    console.log(`Пропущено как уже импортированные (gesn_code): ${totalSkipped}`);
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
 * Идемпотентность: --apply безопасно перезапускать — листья (level=5) с уже
 * существующим gesn_code пропускаются (используется уникальный индекс
 * idx_work_types_gesn_code из миграции 017); узлы level=1-4 ищутся по
 * (parent_id, level, name) / (level=1, gesn_code) перед созданием.
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
 */
