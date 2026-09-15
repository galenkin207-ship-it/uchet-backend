// Разовый идемпотентный импорт текстовых меток единиц шага (step_unit_label)
// в work_types из плоского JSON-файла {gesn_code: текст}. По образцу
// fill-variant-labels.js. Запуск (на сервере, из папки бэкенда — там же
// лежит .env), см. JSDoc внизу файла для примеров.
import "dotenv/config";
import fs from "node:fs";
import { pool } from "../src/db.js";

const DATA_FILE = new URL("./data/step_unit_labels.json", import.meta.url);

// is_counter_step=true — та же выборка "чистых" шаговых групп, что и в
// миграции 019_add_is_counter_step.sql: только они получают step_unit_label,
// остальные is_step_item=true строки (шаги со смешанной базой внутри одной
// группы) этим маппингом не затрагиваются.
async function runUpdate(labels) {
  const entries = Object.entries(labels);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let updated = 0;
    let notFound = 0;
    for (const [gesnCode, label] of entries) {
      const { rowCount } = await client.query(
        "UPDATE work_types SET step_unit_label = $1 WHERE gesn_code = $2 AND is_counter_step = true",
        [label, gesnCode],
      );
      if (rowCount > 0) {
        updated += rowCount;
      } else {
        notFound++;
        console.log(`  не найден код (или is_counter_step=false): ${gesnCode}`);
      }
    }

    console.log("--- Итог ---");
    console.log(`Кодов в JSON: ${entries.length}`);
    console.log(`Обновлено строк: ${updated}`);
    console.log(`Кодов без соответствия в БД: ${notFound}`);

    await client.query("COMMIT");
    console.log("COMMIT выполнен.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Dry-run делает то же сопоставление через SELECT, не трогая данные — чтобы
// заранее увидеть реальные updated/notFound на текущей БД, а не просто
// количество кодов в файле.
async function runDryRun(labels) {
  const entries = Object.entries(labels);

  let updated = 0;
  let notFound = 0;
  for (const [gesnCode, label] of entries) {
    const { rows } = await pool.query(
      "SELECT id FROM work_types WHERE gesn_code = $1 AND is_counter_step = true",
      [gesnCode],
    );
    if (rows.length > 0) {
      updated += rows.length;
      console.log(`  [обновится] ${gesnCode} -> "${label}" (${rows.length} стр.)`);
    } else {
      notFound++;
      console.log(`  [не найден] ${gesnCode}`);
    }
  }

  console.log("--- Dry-run: запись в БД не производится ---");
  console.log(`Кодов в JSON: ${entries.length}`);
  console.log(`Будет обновлено строк: ${updated}`);
  console.log(`Кодов без соответствия в БД: ${notFound}`);
}

function parseArgs() {
  const rest = process.argv.slice(2);
  return {
    dryRun: rest.includes("--dry-run"),
  };
}

async function main() {
  const { dryRun } = parseArgs();
  const labels = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  if (dryRun) {
    console.log(`Файл: ${DATA_FILE.pathname} (${Object.keys(labels).length} кодов)`);
    await runDryRun(labels);
    return;
  }

  await runUpdate(labels);
}

main()
  .catch((err) => {
    console.error("Скрипт упал с ошибкой:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

/**
 * Примеры запуска:
 *
 *   node scripts/fill-step-unit-labels.js --dry-run
 *   node scripts/fill-step-unit-labels.js
 */
