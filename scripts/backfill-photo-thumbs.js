// Разовый бэкафилл превью (thumbnails) для фото, уже перенесённых в S3 в Фазе 1
// (см. migrate-photos-to-s3.js), но залитых туда без превью.
//
// Читает те же локальные файлы из PHOTOS_DIR ("<recordId>/<filename>") — они
// ещё не удалены с диска после миграции — и для каждого генерирует превью
// тем же пайплайном, что и POST /:id/photos (400x400 inside, quality 68),
// заливая его в S3 с ключом "<recordId>/thumb_<filename>".
//
// PHOTOS_TRASH_DIR не трогаем: превью для корзины не нужны, туда фото попадают
// только для восстановления удалённых записей.
//
// Идемпотентный: если превью уже есть в S3 (objectExists) — пропускает,
// можно перезапускать. Локальные файлы не удаляет и не изменяет.
//
// Запуск (на сервере, из папки бэкенда — там же лежит .env):
//   node scripts/backfill-photo-thumbs.js
import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { objectExists, putPhoto } from "../src/s3.js";

const PHOTOS_DIR = process.env.PHOTOS_DIR || "/opt/uchet/uploads/photos";

// Рекурсивно перечисляет файлы в directory, возвращая относительные пути
// (от directory, с "/" как разделителем, независимо от ОС).
async function walk(directory, relativeTo = directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath, relativeTo)));
    } else if (entry.isFile()) {
      files.push(path.relative(relativeTo, fullPath).split(path.sep).join("/"));
    }
  }
  return files;
}

async function main() {
  const stats = { total: 0, created: 0, skipped: 0, errors: [] };

  if (!fs.existsSync(PHOTOS_DIR)) {
    console.log(`${PHOTOS_DIR} — директория не существует, нечего бэкафиллить`);
    return;
  }

  const relativePaths = await walk(PHOTOS_DIR);
  console.log(`${PHOTOS_DIR}: найдено ${relativePaths.length} файлов`);

  for (const relativePath of relativePaths) {
    // relativePath имеет вид "<recordId>/<filename>"
    const slashIndex = relativePath.indexOf("/");
    if (slashIndex === -1) {
      stats.total++;
      stats.errors.push({ key: relativePath, message: "не удалось разобрать recordId из пути" });
      continue;
    }
    const recordId = relativePath.slice(0, slashIndex);
    const filename = relativePath.slice(slashIndex + 1);
    const thumbKey = `${recordId}/thumb_${filename}`;

    stats.total++;
    try {
      if (await objectExists(thumbKey)) {
        stats.skipped++;
      } else {
        const buffer = await fsp.readFile(path.join(PHOTOS_DIR, ...relativePath.split("/")));
        const thumbBuffer = await sharp(buffer)
          .rotate()
          .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 68 })
          .toBuffer();
        await putPhoto(thumbKey, thumbBuffer, "image/jpeg");
        stats.created++;
      }
    } catch (err) {
      stats.errors.push({ key: thumbKey, message: err.message });
    }

    if (stats.total % 50 === 0) {
      console.log(
        `...прогресс: обработано ${stats.total}, создано ${stats.created}, пропущено ${stats.skipped}, ошибок ${stats.errors.length}`,
      );
    }
  }

  console.log("\n--- Итог ---");
  console.log(`Всего файлов: ${stats.total}`);
  console.log(`Создано превью: ${stats.created}`);
  console.log(`Пропущено (уже есть в S3): ${stats.skipped}`);
  console.log(`Ошибок: ${stats.errors.length}`);
  if (stats.errors.length) {
    console.log("Детали ошибок:");
    for (const { key, message } of stats.errors) {
      console.log(`  ${key}: ${message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Бэкафилл упал с необработанной ошибкой:", err);
  process.exitCode = 1;
});
