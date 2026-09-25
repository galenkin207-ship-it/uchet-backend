import "dotenv/config";
import { pool } from "../src/db.js";
import OpenAI from "openai";

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 100;
const MODEL = "text-embedding-3-small";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildText(row) {
  const parts = [row.name, row.variant_label, row.work_composition].filter(Boolean);
  return parts.join(". ");
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY не задан в .env");
    process.exit(1);
  }

  console.log(`Режим: ${APPLY ? "APPLY (реальная запись + траты токенов)" : "DRY-RUN (без API-вызовов, без записи)"}`);

  const { rows } = await pool.query(
    `SELECT id, name, variant_label, work_composition
     FROM work_types
     WHERE level = 5 AND is_step_item = false AND embedding IS NULL
     ORDER BY id`
  );

  console.log(`Позиций без эмбеддинга: ${rows.length}`);

  if (rows.length === 0) {
    await pool.end();
    return;
  }

  console.log("Пример текста для эмбеддинга (первая позиция):");
  console.log(`  id=${rows[0].id}: "${buildText(rows[0])}"`);

  if (!APPLY) {
    console.log("---");
    console.log(`Батчей по ${BATCH_SIZE} штук: ${Math.ceil(rows.length / BATCH_SIZE)}`);
    console.log("Это dry-run — API не вызывался, ничего не потрачено и не записано.");
    await pool.end();
    return;
  }

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map(buildText);

    try {
      const response = await openai.embeddings.create({
        model: MODEL,
        input: texts,
      });

      for (let j = 0; j < batch.length; j++) {
        const vector = response.data[j].embedding;
        await pool.query(
          `UPDATE work_types SET embedding = $1 WHERE id = $2`,
          [JSON.stringify(vector), batch[j].id]
        );
      }

      processed += batch.length;
      console.log(`Обработано: ${processed}/${rows.length}`);
    } catch (err) {
      failed += batch.length;
      console.error(`Ошибка на батче ${i}-${i + batch.length}:`, err.message);
    }
  }

  console.log("---");
  console.log(`Успешно проиндексировано: ${processed}`);
  console.log(`Не удалось (ошибки): ${failed}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
