// Разовый идемпотентный импорт текстовых меток вариантов (variant_label) в
// work_types из плоского JSON-файла {gesn_code: текст}. Запуск (на сервере,
// из папки бэкенда — там же лежит .env), см. JSDoc внизу файла для примеров.
import "dotenv/config";
import fs from "node:fs";
import { pool } from "../src/db.js";

const DATA_FILE = new URL("./data/variant_labels.json", import.meta.url);

async function runUpdate(labels) {
  const entries = Object.entries(labels);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let updated = 0;
    let notFound = 0;
    for (const [gesnCode, label] of entries) {
      const { rowCount } = await client.query(
        "UPDATE work_types SET variant_label = $1 WHERE gesn_code = $2",
        [label, gesnCode],
      );
      if (rowCount > 0) {
        updated += rowCount;
      } else {
        notFound++;
      }
    }

    console.log("--- Итог ---");
    console.log(`Кодов в JSON: ${entries.length}`);
    console.log(`Обновлено строк: ${updated}`);
    console.log(
      `Кодов без соответствия в БД: ${notFound} (ожидаемо — legacy-позиции не участвуют в этом маппинге)`,
    );

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
  const rest = process.argv.slice(2);
  return {
    dryRun: rest.includes("--dry-run"),
  };
}

async function main() {
  const { dryRun } = parseArgs();
  const labels = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const entries = Object.entries(labels);

  if (dryRun) {
    console.log(`Файл: ${DATA_FILE.pathname} (${entries.length} кодов)`);
    console.log("--- Dry-run: запись в БД не производится ---");
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
 *   node scripts/fill-variant-labels.js --dry-run
 *   node scripts/fill-variant-labels.js
 */
