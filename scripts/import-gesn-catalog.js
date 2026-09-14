// Разовый импорт каталога ГЭСН в дерево work_types (level 1-5) из плоского
// JSON-файла. Строит уровни сборник -> раздел -> таблица -> группа -> вариант
// (лист), дедуплицируя узлы верхних уровней по цепочке родительских ключей,
// и связывает доп_позиции (is_step_item) с их базовой нормой по gesn_code,
// извлечённому из поля "базовая_норма".
//
// Запуск (на сервере, из папки бэкенда — там же лежит .env), см. JSDoc внизу
// файла для примеров.
import "dotenv/config";
import fs from "node:fs";
import { pool } from "../src/db.js";

const EXPECTED_LEAF_COUNT = 12291;
const EXPECTED_PRICED_COUNT = 9865;
const EXPECTED_STEP_COUNT = 1120;

// Код нормы внутри строки "базовая_норма", например "01-01-001-01" (последняя
// группа из 2 цифр опциональна — не все коды ГЭСН её содержат).
const BASE_NORM_CODE_RE = /\d{2}-\d{2}-\d{3}(?:-\d{2})?/;

const COMMON_COLUMNS = [
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
];

function toRow(node) {
  return [
    node.name,
    node.unit,
    node.price,
    node.level,
    node.parentId,
    node.catalogType,
    node.gesnCode,
    node.laborHours,
    node.workComposition,
    node.isStepItem,
    node.sortOrder,
    "gesn_catalog",
    node.hasPrice,
  ];
}

// Пакетная вставка (VALUES по batchSize строк за раз), возвращает id новых
// строк в том же порядке, в каком переданы rows — Postgres гарантирует такой
// порядок для RETURNING на многострочном INSERT ... VALUES.
async function batchInsert(client, columns, rows, batchSize = 500) {
  const ids = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize);
    const valuesSql = [];
    const params = [];
    chunk.forEach((row, i) => {
      const placeholders = columns.map((_, colIdx) => `$${i * columns.length + colIdx + 1}`);
      valuesSql.push(`(${placeholders.join(",")})`);
      params.push(...row);
    });
    const sql = `INSERT INTO work_types (${columns.join(",")}) VALUES ${valuesSql.join(",")} RETURNING id`;
    const { rows: inserted } = await client.query(sql, params);
    ids.push(...inserted.map((r) => r.id));
  }
  return ids;
}

// Строит дерево уровней 1-4 (с дедупликацией по цепочке родительских ключей)
// и плоский список листьев (уровень 5, вариант) из массива позиций каталога.
function buildTree(items) {
  const level1 = [];
  const level2 = [];
  const level3 = [];
  const level4 = [];
  const leaves = [];

  const level1Index = new Map();
  const level2Index = new Map();
  const level3Index = new Map();
  const level4Index = new Map();

  // Порядковый номер следующего ребёнка данного родителя (ключ родителя, или
  // "root" для верхнего уровня) — используется как sort_order.
  const childCounters = new Map();
  function nextOrder(parentKey) {
    const n = childCounters.get(parentKey) ?? 0;
    childCounters.set(parentKey, n + 1);
    return n;
  }

  for (const item of items) {
    const catalogType = item["тип"];

    const l1Key = `${catalogType}${item["сборник_название"]}`;
    if (!level1Index.has(l1Key)) {
      level1Index.set(l1Key, level1.length);
      level1.push({
        key: l1Key,
        name: item["сборник_название"],
        catalogType,
        gesnCode: item["сборник"],
        sortOrder: nextOrder("root"),
      });
    }

    const l2Key = `${l1Key}${item["раздел"]}`;
    if (!level2Index.has(l2Key)) {
      level2Index.set(l2Key, level2.length);
      level2.push({
        key: l2Key,
        parentKey: l1Key,
        name: item["раздел"],
        catalogType,
        sortOrder: nextOrder(l1Key),
      });
    }

    const l3Key = `${l2Key}${item["таблица"]}`;
    if (!level3Index.has(l3Key)) {
      level3Index.set(l3Key, level3.length);
      level3.push({
        key: l3Key,
        parentKey: l2Key,
        name: item["таблица"],
        catalogType,
        sortOrder: nextOrder(l2Key),
      });
    }

    const l4Key = `${l3Key}${item["группа"]}`;
    if (!level4Index.has(l4Key)) {
      level4Index.set(l4Key, level4.length);
      level4.push({
        key: l4Key,
        parentKey: l3Key,
        name: item["группа"],
        catalogType,
        sortOrder: nextOrder(l3Key),
      });
    }

    const hasPrice = !!item["есть_цена"];
    leaves.push({
      parentKey: l4Key,
      catalogType,
      name: item["наименование"],
      unit: item["ед_изм"],
      gesnCode: item["код"],
      laborHours: item["трудозатраты_чел_ч"],
      workComposition: item["состав_работ"],
      isStepItem: !!item["доп_позиция"],
      hasPrice,
      price: hasPrice ? item["цена_текущая"] : 0,
      baseNormRaw: item["базовая_норма"] || "",
      sortOrder: nextOrder(l4Key),
    });
  }

  return { level1, level2, level3, level4, leaves };
}

function computeStats(tree) {
  const priced = tree.leaves.filter((l) => l.hasPrice).length;
  const stepItems = tree.leaves.filter((l) => l.isStepItem).length;
  return {
    level1: tree.level1.length,
    level2: tree.level2.length,
    level3: tree.level3.length,
    level4: tree.level4.length,
    level5: tree.leaves.length,
    priced,
    unpriced: tree.leaves.length - priced,
    stepItems,
  };
}

function printStats(stats) {
  console.log(`Уровень 1 (сборники): ${stats.level1}`);
  console.log(`Уровень 2 (разделы): ${stats.level2}`);
  console.log(`Уровень 3 (таблицы): ${stats.level3}`);
  console.log(`Уровень 4 (группы): ${stats.level4}`);
  console.log(`Уровень 5 (варианты, листья): ${stats.level5}`);
  console.log(`  с ценой: ${stats.priced}`);
  console.log(`  без цены: ${stats.unpriced}`);
  console.log(`  доп_позиция (is_step_item): ${stats.stepItems}`);
}

function checkExpected(label, actual, expected) {
  if (actual !== expected) {
    console.warn(
      `WARNING: ${label} — получено ${actual}, ожидалось ${expected} (разница ${actual - expected})`,
    );
  }
}

async function runImport(tree, force) {
  const { rows: existing } = await pool.query(
    "SELECT 1 FROM work_types WHERE source = 'gesn_catalog' LIMIT 1",
  );
  if (existing.length && !force) {
    console.error("Каталог уже импортирован, для повторного импорта передайте --force");
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (existing.length && force) {
      // parent_id и step_base_work_type_id у work_types — ON DELETE SET NULL,
      // так что удаление всего среза source='gesn_catalog' одним DELETE
      // безопасно для внутренних ссылок дерева на самого себя.
      await client.query("DELETE FROM work_types WHERE source = 'gesn_catalog'");
    }

    const level1Ids = await batchInsert(
      client,
      COMMON_COLUMNS,
      tree.level1.map((n) =>
        toRow({
          name: n.name,
          unit: "-",
          price: 0,
          level: 1,
          parentId: null,
          catalogType: n.catalogType,
          gesnCode: n.gesnCode,
          laborHours: null,
          workComposition: null,
          isStepItem: false,
          sortOrder: n.sortOrder,
          hasPrice: false,
        }),
      ),
    );
    const level1IdByKey = new Map(tree.level1.map((n, i) => [n.key, level1Ids[i]]));

    const level2Ids = await batchInsert(
      client,
      COMMON_COLUMNS,
      tree.level2.map((n) =>
        toRow({
          name: n.name,
          unit: "-",
          price: 0,
          level: 2,
          parentId: level1IdByKey.get(n.parentKey),
          catalogType: n.catalogType,
          gesnCode: null,
          laborHours: null,
          workComposition: null,
          isStepItem: false,
          sortOrder: n.sortOrder,
          hasPrice: false,
        }),
      ),
    );
    const level2IdByKey = new Map(tree.level2.map((n, i) => [n.key, level2Ids[i]]));

    const level3Ids = await batchInsert(
      client,
      COMMON_COLUMNS,
      tree.level3.map((n) =>
        toRow({
          name: n.name,
          unit: "-",
          price: 0,
          level: 3,
          parentId: level2IdByKey.get(n.parentKey),
          catalogType: n.catalogType,
          gesnCode: null,
          laborHours: null,
          workComposition: null,
          isStepItem: false,
          sortOrder: n.sortOrder,
          hasPrice: false,
        }),
      ),
    );
    const level3IdByKey = new Map(tree.level3.map((n, i) => [n.key, level3Ids[i]]));

    const level4Ids = await batchInsert(
      client,
      COMMON_COLUMNS,
      tree.level4.map((n) =>
        toRow({
          name: n.name,
          unit: "-",
          price: 0,
          level: 4,
          parentId: level3IdByKey.get(n.parentKey),
          catalogType: n.catalogType,
          gesnCode: null,
          laborHours: null,
          workComposition: null,
          isStepItem: false,
          sortOrder: n.sortOrder,
          hasPrice: false,
        }),
      ),
    );
    const level4IdByKey = new Map(tree.level4.map((n, i) => [n.key, level4Ids[i]]));

    const leafIds = await batchInsert(
      client,
      COMMON_COLUMNS,
      tree.leaves.map((leaf) =>
        toRow({
          name: leaf.name,
          unit: leaf.unit,
          price: leaf.price,
          level: 5,
          parentId: level4IdByKey.get(leaf.parentKey),
          catalogType: leaf.catalogType,
          gesnCode: leaf.gesnCode,
          laborHours: leaf.laborHours,
          workComposition: leaf.workComposition,
          isStepItem: leaf.isStepItem,
          sortOrder: leaf.sortOrder,
          hasPrice: leaf.hasPrice,
        }),
      ),
    );

    // gesn_code -> id только среди листьев, вставленных в этом прогоне — по
    // условию задачи step_base_work_type_id разрешается исключительно внутри
    // только что импортированного среза.
    const leafIdByGesnCode = new Map();
    tree.leaves.forEach((leaf, i) => {
      if (leaf.gesnCode) leafIdByGesnCode.set(leaf.gesnCode, leafIds[i]);
    });

    let stepResolved = 0;
    let stepUnresolved = 0;
    for (let i = 0; i < tree.leaves.length; i++) {
      const leaf = tree.leaves[i];
      if (!leaf.isStepItem || !leaf.baseNormRaw) continue;
      const match = leaf.baseNormRaw.match(BASE_NORM_CODE_RE);
      const baseId = match ? leafIdByGesnCode.get(match[0]) : undefined;
      if (baseId) {
        await client.query("UPDATE work_types SET step_base_work_type_id = $1 WHERE id = $2", [
          baseId,
          leafIds[i],
        ]);
        stepResolved++;
      } else {
        stepUnresolved++;
      }
    }

    const priced = tree.leaves.filter((l) => l.hasPrice).length;
    const stepItems = tree.leaves.filter((l) => l.isStepItem).length;

    console.log("--- Итог импорта ---");
    console.log(`Уровень 1 (сборники): ${level1Ids.length}`);
    console.log(`Уровень 2 (разделы): ${level2Ids.length}`);
    console.log(`Уровень 3 (таблицы): ${level3Ids.length}`);
    console.log(`Уровень 4 (группы): ${level4Ids.length}`);
    console.log(`Уровень 5 (варианты, листья): ${leafIds.length}`);
    console.log(`  с ценой (has_price): ${priced}`);
    console.log(`  доп_позиция (is_step_item): ${stepItems}`);
    console.log(`    из них с найденной базовой нормой (step_base_work_type_id): ${stepResolved}`);
    console.log(`    без совпадения по gesn_code: ${stepUnresolved}`);

    checkExpected("количество листьев", leafIds.length, EXPECTED_LEAF_COUNT);
    checkExpected("количество листьев с ценой", priced, EXPECTED_PRICED_COUNT);
    checkExpected("количество доп_позиций", stepItems, EXPECTED_STEP_COUNT);

    await client.query("COMMIT");
    console.log("COMMIT выполнен.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function parseArgs() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(
      "Использование: node scripts/import-gesn-catalog.js <path.json> [--dry-run] [--force]",
    );
    process.exit(1);
  }
  const rest = process.argv.slice(3);
  return {
    filePath,
    dryRun: rest.includes("--dry-run"),
    force: rest.includes("--force"),
  };
}

async function main() {
  const { filePath, dryRun, force } = parseArgs();
  const items = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const tree = buildTree(items);

  if (dryRun) {
    console.log(`Файл: ${filePath} (${items.length} позиций во входном массиве)`);
    console.log("--- Dry-run: статистика без записи в БД ---");
    printStats(computeStats(tree));
    return;
  }

  await runImport(tree, force);
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
 * Примеры запуска:
 *
 *   node scripts/import-gesn-catalog.js /path/to/catalog.json --dry-run
 *   node scripts/import-gesn-catalog.js /path/to/catalog.json
 *   node scripts/import-gesn-catalog.js /path/to/catalog.json --force
 */
