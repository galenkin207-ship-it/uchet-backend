// Проверяет, что все файлы из migrations/ отмечены применёнными в таблице
// schema_migrations. Запускается в CI на сервере ПОСЛЕ rsync (когда новый
// код и новые файлы миграций уже на диске), но ДО restart сервиса — если
// каких-то миграций не хватает, деплой останавливается и старая версия
// продолжает работать (см. .github/workflows/deploy.yml, rollback()).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("Миграций в migrations/ нет — проверять нечего.");
    process.exit(0);
  }

  let applied;
  try {
    const { rows } = await pool.query("SELECT filename FROM schema_migrations");
    applied = new Set(rows.map((r) => r.filename));
  } catch (err) {
    console.error("Не удалось прочитать таблицу schema_migrations:", err.message);
    console.error(
      "Похоже, миграция add_schema_migrations_tracking.sql ещё не применена вручную на сервере.",
    );
    console.error("Примените её через MobaXterm: sudo -u postgres psql -d uchet_db, затем повторите деплой.");
    process.exit(1);
  }

  const missing = files.filter((f) => !applied.has(f));

  if (missing.length > 0) {
    console.error("!!! На проде не применены SQL-миграции:");
    for (const f of missing) console.error(`  - ${f}`);
    console.error("");
    console.error("Примените их вручную:");
    console.error("  1) MobaXterm на сервере -> sudo -u postgres psql -d uchet_db");
    console.error("  2) выполните содержимое каждого файла выше по очереди");
    console.error("  3) заново запустите этот деплой (Re-run jobs в GitHub Actions)");
    process.exit(1);
  }

  console.log(`Все ${files.length} миграций применены — продолжаю деплой.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Ошибка проверки миграций:", err);
  process.exit(1);
});
