import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const DATA_FILE = fileURLToPath(new URL("./data/work_composition.json", import.meta.url));
const APPLY = process.argv.includes("--apply");

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  console.log(`Загружено записей из JSON: ${data.length}`);
  console.log(`Режим: ${APPLY ? "APPLY (реальная запись)" : "DRY-RUN (только отчёт)"}`);

  let updated = 0;
  let alreadyFilled = 0;
  let notFound = 0;

  for (const row of data) {
    const { rows } = await pool.query(
      `SELECT wt.id, wt.work_composition
       FROM work_types wt
       JOIN work_types s ON s.id = wt.sbornik_id
       WHERE s.gesn_code = $1 AND wt.gesn_code = $2 AND wt.level = 5`,
      [row.sbornik_code, row.leaf_code]
    );

    if (rows.length === 0) {
      notFound++;
      continue;
    }

    const target = rows[0];
    if (target.work_composition !== null) {
      alreadyFilled++;
      continue;
    }

    if (APPLY) {
      await pool.query(
        `UPDATE work_types SET work_composition = $1 WHERE id = $2`,
        [row.work_composition, target.id]
      );
    }
    updated++;
  }

  console.log("---");
  console.log(`Обновлено (или было бы обновлено): ${updated}`);
  console.log(`Уже были заполнены (пропущены): ${alreadyFilled}`);
  console.log(`Не найдено соответствия в БД: ${notFound}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
