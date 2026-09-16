// Разовый импорт пользовательского прайс-справочника (не ГЭСН) в дерево
// work_types из scripts/data/import_data.json — см. JSDoc внизу файла для
// формата входного файла и примеров запуска.
//
// В отличие от import-gesn-catalog.js, здесь дерево НЕ обязано иметь все 5
// уровней подряд: level — просто атрибут узла, фактическая иерархия строится
// только через parent_id (подтверждено чтением work-types-tree.js — leaf_ancestors
// и /search breadcrumb работают по parent_id независимо от того, сколько
// уровней реально пройдено). Поэтому лист (level=5) может быть напрямую
// ребёнком сборника (level=1) или раздела (level=2), без промежуточных
// фиктивных узлов level=3/4.
import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const DEFAULT_FILE = fileURLToPath(new URL("./data/import_data.json", import.meta.url));

// Три позиции с битым unit/price (обрывок вида ";шт;6 000" — баг при экспорте
// из исходной таблицы Константина). Подтверждено: исключить из этого прогона,
// добавить отдельно после ручного исправления исходных данных.
const EXCLUDED_NUMS = new Set([238, 459, 462]);

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function parseArgs() {
  const rest = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith("--"));
  return {
    filePath: positional[0] || DEFAULT_FILE,
    dryRun: rest.includes("--dry-run"),
    apply: rest.includes("--apply"),
  };
}

function validateItems(items) {
  const errors = [];
  items.forEach((it, i) => {
    if (it.kind !== "group" && it.kind !== "single") {
      errors.push(`#${i}: неизвестный kind=${it.kind}`);
      return;
    }
    if (isBlank(it.sbornik) || isBlank(it.type)) {
      errors.push(`#${i} (num=${it.kind === "single" ? it.num : "group"}): пустой sbornik/type`);
    }
    if (it.kind === "single") {
      if (isBlank(it.name) || isBlank(it.unit) || it.price == null || it.num == null) {
        errors.push(`#${i} (num=${it.num}): неполные поля single`);
      }
    } else {
      if (isBlank(it.group_name) || isBlank(it.unit) || !Array.isArray(it.variants) || it.variants.length === 0) {
        errors.push(`#${i}: неполные поля group (group_name=${it.group_name})`);
      }
      for (const v of it.variants || []) {
        if (isBlank(v.variant) || v.price == null || v.num == null) {
          errors.push(`#${i} group_name=${it.group_name}, variant num=${v.num}: неполные поля variant`);
        }
      }
    }
  });
  return errors;
}

// Разворачивает входной файл в плоский список "листовых задач" — по одной
// на будущую строку level=5 (single остаётся одной задачей, group даёт по
// задаче на каждый вариант) — с сохранением ссылки на исходный item для
// определения sbornik/type/razdel/razdel_is_new и (для group) group_name/unit.
function flattenLeafTasks(items) {
  const tasks = [];
  for (const item of items) {
    if (item.kind === "single") {
      if (EXCLUDED_NUMS.has(item.num)) continue;
      tasks.push({
        item,
        num: item.num,
        name: item.name,
        unit: item.unit,
        price: item.price,
        variantLabel: null,
        groupName: null,
      });
    } else {
      for (const v of item.variants) {
        if (EXCLUDED_NUMS.has(v.num)) continue;
        tasks.push({
          item,
          num: v.num,
          name: `${item.group_name}: ${v.variant}`,
          unit: item.unit,
          price: v.price,
          variantLabel: v.variant,
          groupName: item.group_name,
        });
      }
    }
  }
  return tasks;
}

// Резолвер узлов дерева поверх кэшей — единая логика для --dry-run (id узлов,
// которые ещё предстоит создать, — отрицательные "фиктивные" числа, никогда
// не уходящие в SQL) и для --apply (настоящие id, узлы создаются по ходу
// внутри одной транзакции). Кэши гарантируют, что при нескольких task,
// ссылающихся на один и тот же новый раздел/группу, узел создаётся один раз.
// Ключи кэшей — через "|": ни в одном поле входного файла пайп не встречается
// (проверено), а не juggling escape-последовательностей в шаблонных строках.
function createResolver(client, { dryRun }) {
  const sbornikCache = new Map(); // "type|sbornik" -> id | null
  const razdelCache = new Map(); // "sbornikId|razdelName" -> id | null
  const newRazdelParentCache = new Map(); // sbornikId -> { level2Id, level2Name } | { error }
  const containerCache = new Map(); // "parentId|level|name" -> id
  const sortCounters = new Map(); // parentId -> next sort_order
  let nextFakeId = -1;

  const stats = {
    newLevel3ToCreate: [],
    level4ToCreate: [],
  };

  async function findSbornik(sbornik, type) {
    const key = `${type}|${sbornik}`;
    if (sbornikCache.has(key)) return sbornikCache.get(key);
    const { rows } = await client.query(
      "SELECT id FROM work_types WHERE level = 1 AND catalog_type = $1 AND name = $2",
      [type, sbornik],
    );
    const id = rows[0]?.id ?? null;
    sbornikCache.set(key, id);
    return id;
  }

  async function findExistingRazdel(sbornikId, razdelName) {
    const key = `${sbornikId}|${razdelName}`;
    if (razdelCache.has(key)) return razdelCache.get(key);
    const { rows } = await client.query(
      "SELECT id FROM work_types WHERE parent_id = $1 AND level = 2 AND name = $2",
      [sbornikId, razdelName],
    );
    const id = rows[0]?.id ?? null;
    razdelCache.set(key, id);
    return id;
  }

  // Для razdel_is_new=true новый узел level=3 паrentится под ЕДИНСТВЕННЫЙ
  // существующий level=2 узел сборника (подтверждено на выборке файла: все
  // сборники с новыми разделами не ссылаются ни на один существующий razdel —
  // т.е. это "плоские" каталоги с одним общим разделом-контейнером). Если у
  // сборника 0 или >1 узлов level=2 — не гадаем, репортим как ошибку.
  async function findSoleLevel2Parent(sbornikId) {
    if (newRazdelParentCache.has(sbornikId)) return newRazdelParentCache.get(sbornikId);
    const { rows } = await client.query(
      "SELECT id, name FROM work_types WHERE parent_id = $1 AND level = 2",
      [sbornikId],
    );
    let result;
    if (rows.length === 1) {
      result = { level2Id: rows[0].id, level2Name: rows[0].name };
    } else {
      result = { error: `у сборника id=${sbornikId} найдено level=2 узлов: ${rows.length} (ожидался 1)` };
    }
    newRazdelParentCache.set(sbornikId, result);
    return result;
  }

  async function getOrCreateContainer({ parentId, level, name, catalogType, createdList }) {
    const key = `${parentId}|${level}|${name}`;
    if (containerCache.has(key)) return containerCache.get(key);

    if (parentId > 0) {
      const { rows } = await client.query(
        "SELECT id FROM work_types WHERE parent_id = $1 AND level = $2 AND name = $3",
        [parentId, level, name],
      );
      if (rows.length) {
        containerCache.set(key, rows[0].id);
        return rows[0].id;
      }
    }

    if (dryRun) {
      const id = nextFakeId--;
      containerCache.set(key, id);
      createdList.push({ level, name, parentId });
      return id;
    }

    const sortOrder = await nextSortOrder(parentId);
    const { rows } = await client.query(
      `INSERT INTO work_types (name, level, parent_id, catalog_type, unit, price, has_price, source, sort_order)
       VALUES ($1,$2,$3,$4,'-',0,false,'user_added',$5) RETURNING id`,
      [name, level, parentId, catalogType, sortOrder],
    );
    containerCache.set(key, rows[0].id);
    return rows[0].id;
  }

  async function nextSortOrder(parentId) {
    if (!sortCounters.has(parentId)) {
      let base = 0;
      if (parentId > 0) {
        const { rows } = await client.query(
          "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM work_types WHERE parent_id = $1",
          [parentId],
        );
        base = rows[0].next;
      }
      sortCounters.set(parentId, base);
    }
    const n = sortCounters.get(parentId);
    sortCounters.set(parentId, n + 1);
    return n;
  }

  // Резолвит "родителя раздела" для одного item (single или group) — либо
  // существующий узел (level=1 напрямую при razdel=null, level=2 при точном
  // совпадении имени), либо только что созданный/зарезервированный level=3
  // "новый раздел". Возвращает { parentId, catalogType } или { error }.
  async function resolveSectionParent(item) {
    const sbornikId = await findSbornik(item.sbornik, item.type);
    if (sbornikId == null) {
      return { error: `сборник не найден: "${item.sbornik}" (type="${item.type}")` };
    }

    const razdelBlank = isBlank(item.razdel);

    if (razdelBlank && !item.razdel_is_new) {
      // Подтверждено Константином: razdel=null + razdel_is_new=false —
      // позиция без раздела, парентится прямо под сборник (level=1).
      return { parentId: sbornikId, catalogType: item.type };
    }

    if (!item.razdel_is_new) {
      const razdelId = await findExistingRazdel(sbornikId, item.razdel);
      if (razdelId == null) {
        return { error: `раздел не найден: сборник="${item.sbornik}", razdel="${item.razdel}"` };
      }
      return { parentId: razdelId, catalogType: item.type };
    }

    // razdel_is_new === true
    const parent = await findSoleLevel2Parent(sbornikId);
    if (parent.error) {
      return { error: `новый раздел "${item.razdel}" в сборнике "${item.sbornik}": ${parent.error}` };
    }
    const newLevel3Id = await getOrCreateContainer({
      parentId: parent.level2Id,
      level: 3,
      name: item.razdel,
      catalogType: item.type,
      createdList: stats.newLevel3ToCreate,
    });
    return { parentId: newLevel3Id, catalogType: item.type };
  }

  return { resolveSectionParent, getOrCreateContainer, nextSortOrder, stats };
}

export async function buildPlan(client, items, { dryRun }) {
  const validationErrors = validateItems(items);
  const tasks = flattenLeafTasks(items);

  const nums = tasks.map((t) => t.num);
  const { rows: existingRows } = nums.length
    ? await client.query("SELECT legacy_num FROM work_types WHERE legacy_num = ANY($1)", [nums])
    : { rows: [] };
  const alreadyImported = new Set(existingRows.map((r) => r.legacy_num));

  const resolver = createResolver(client, { dryRun });
  const errors = [];
  const toInsertLeaves = [];
  const examples = [];
  let skippedExisting = 0;

  for (const task of tasks) {
    if (alreadyImported.has(task.num)) {
      skippedExisting++;
      continue;
    }

    const section = await resolver.resolveSectionParent(task.item);
    if (section.error) {
      errors.push({ num: task.num, reason: section.error });
      continue;
    }

    let parentId = section.parentId;
    let pathTail = [];
    if (task.groupName) {
      const groupId = await resolver.getOrCreateContainer({
        parentId,
        level: 4,
        name: task.groupName,
        catalogType: section.catalogType,
        createdList: resolver.stats.level4ToCreate,
      });
      parentId = groupId;
      pathTail = [task.groupName];
    }

    const sortOrder = await resolver.nextSortOrder(parentId);
    toInsertLeaves.push({
      parentId,
      catalogType: section.catalogType,
      name: task.name,
      unit: task.unit,
      price: task.price,
      variantLabel: task.variantLabel,
      legacyNum: task.num,
      sortOrder,
    });

    if (examples.length < 12) {
      const razdelLabel = isBlank(task.item.razdel) ? null : task.item.razdel;
      examples.push({
        num: task.num,
        path: [task.item.sbornik, razdelLabel, ...pathTail, task.name].filter((x) => x != null),
        isNewRazdel: !!task.item.razdel_is_new,
        hasGroup: !!task.groupName,
      });
    }
  }

  return {
    validationErrors,
    resolutionErrors: errors,
    skippedExisting,
    toInsertLeaves,
    examples,
    newLevel3ToCreate: resolver.stats.newLevel3ToCreate,
    level4ToCreate: resolver.stats.level4ToCreate,
    totalTasks: tasks.length,
  };
}

function printReport(plan) {
  console.log("--- Валидация входного файла ---");
  console.log(`Ошибок валидации структуры: ${plan.validationErrors.length}`);
  for (const e of plan.validationErrors.slice(0, 20)) console.log(`  ${e}`);
  if (plan.validationErrors.length > 20) console.log(`  ...и ещё ${plan.validationErrors.length - 20}`);

  console.log(`\nИсключено (EXCLUDED_NUMS, битые unit/price): ${[...EXCLUDED_NUMS].join(", ")}`);

  console.log("\n--- План вставки ---");
  console.log(`Всего листовых позиций в файле (после исключений): ${plan.totalTasks}`);
  console.log(`Уже импортировано ранее (найдено по legacy_num, пропускаем): ${plan.skippedExisting}`);
  console.log(`Ошибок резолва родителя (позиция НЕ будет вставлена): ${plan.resolutionErrors.length}`);
  for (const e of plan.resolutionErrors.slice(0, 20)) console.log(`  num=${e.num}: ${e.reason}`);
  if (plan.resolutionErrors.length > 20) console.log(`  ...и ещё ${plan.resolutionErrors.length - 20}`);

  console.log(`\nНовых узлов level=3 (новые разделы): ${plan.newLevel3ToCreate.length}`);
  for (const n of plan.newLevel3ToCreate) console.log(`  + "${n.name}" (parent_id=${n.parentId})`);

  console.log(`\nНовых узлов level=4 (группы): ${plan.level4ToCreate.length}`);
  console.log(`Новых листьев level=5 (варианты/одиночные позиции) к вставке: ${plan.toInsertLeaves.length}`);

  console.log("\n--- Примеры итоговых путей ---");
  for (const ex of plan.examples) {
    const tag = ex.isNewRazdel ? "[новый раздел]" : ex.hasGroup ? "[группа]" : "";
    console.log(`  num=${ex.num} ${tag} ${ex.path.join(" → ")}`);
  }
}

async function runApply(client, plan) {
  if (plan.validationErrors.length > 0) {
    throw new Error(`Есть ошибки валидации (${plan.validationErrors.length}) — сначала почините файл.`);
  }
  if (plan.resolutionErrors.length > 0) {
    throw new Error(
      `Есть ${plan.resolutionErrors.length} нерезолвленных позиций — сначала разберитесь с ними (см. --dry-run).`,
    );
  }

  let inserted = 0;
  for (const leaf of plan.toInsertLeaves) {
    await client.query(
      `INSERT INTO work_types
         (name, level, parent_id, catalog_type, unit, price, has_price, is_step_item,
          is_counter_step, gesn_code, variant_label, legacy_num, source, sort_order)
       VALUES ($1,5,$2,$3,$4,$5,true,false,false,NULL,$6,$7,'user_added',$8)`,
      [
        leaf.name,
        leaf.parentId,
        leaf.catalogType,
        leaf.unit,
        leaf.price,
        leaf.variantLabel,
        leaf.legacyNum,
        leaf.sortOrder,
      ],
    );
    inserted++;
  }
  return inserted;
}

async function main() {
  const { filePath, dryRun, apply } = parseArgs();
  if (!dryRun && !apply) {
    console.error("Укажите --dry-run (посмотреть план) или --apply (выполнить вставку).");
    process.exitCode = 1;
    return;
  }

  const items = JSON.parse(fs.readFileSync(filePath, "utf8"));
  console.log(`Файл: ${filePath} (${items.length} позиций верхнего уровня)`);

  const client = await pool.connect();
  try {
    if (dryRun) {
      const plan = await buildPlan(client, items, { dryRun: true });
      printReport(plan);
      return;
    }

    await client.query("BEGIN");
    const plan = await buildPlan(client, items, { dryRun: false });
    const inserted = await runApply(client, plan);
    console.log(`Вставлено новых листьев: ${inserted}`);
    console.log(`Пропущено как уже импортированные (legacy_num): ${plan.skippedExisting}`);
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
 * Формат входного файла (массив объектов), два вида элементов:
 *   { sbornik, type, razdel, razdel_is_new, kind: "group", group_name, unit,
 *     variants: [{ num, variant, price }, ...] }
 *   { sbornik, type, razdel, razdel_is_new, kind: "single", name, unit, price, num }
 *
 * Примеры запуска (на сервере, из папки бэкенда — там же лежит .env):
 *
 *   node scripts/import-user-catalog.js scripts/data/import_data.json --dry-run
 *   node scripts/import-user-catalog.js scripts/data/import_data.json --apply
 *
 * Идемпотентность: --apply безопасно перезапускать — листья с уже
 * существующим legacy_num пропускаются, новые level=3/level=4 узлы ищутся
 * по (parent_id, level, name) перед созданием.
 */
