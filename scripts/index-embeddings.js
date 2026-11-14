import "dotenv/config";
import { pool } from "../src/db.js";
import { getEmbeddings } from "../src/embeddings.js";

// Пересчёт эмбеддингов листьев справочника через локальную службу uchet-embed (bge-m3).
// Берёт только позиции без эмбеддинга. .env читается из текущей директории,
// запускать из корня бэкенда, как и сервис.
// По умолчанию пробный запуск (без записи); запись только с флагом --apply.

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 16; // максимум службы за один запрос

function buildText(row) {
  const parts = [row.name, row.variant_label, row.work_composition].filter(Boolean);
  return parts.join(". ");
}

// Только статус или имя ошибки: текст ошибок может содержать лишнее
function reason(err) {
  return err?.status ?? err?.cause?.code ?? err?.name ?? "error";
}

async function main() {
  console.log(`Режим: ${APPLY ? "APPLY (реальная запись)" : "DRY-RUN (без вызовов службы, без записи)"}`);

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
    console.log("Это dry-run: служба не вызывалась, ничего не записано.");
    await pool.end();
    return;
  }

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await getEmbeddings(batch.map(buildText));
      for (let j = 0; j < batch.length; j++) {
        await pool.query(`UPDATE work_types SET embedding = $1 WHERE id = $2`, [
          JSON.stringify(vectors[j]),
          batch[j].id,
        ]);
      }
      processed += batch.length;
      console.log(`Обработано: ${processed}/${rows.length}`);
    } catch (err) {
      failed += batch.length;
      console.error(`Ошибка на батче ${i}-${i + batch.length}: ${reason(err)}`);
    }
  }

  console.log("---");
  console.log(`Успешно проиндексировано: ${processed}`);
  console.log(`Не удалось (ошибки): ${failed}`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});