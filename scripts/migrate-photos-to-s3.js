// Разовая миграция фото записей с локального диска в S3 (Beget Object Storage).
// Заливает файлы из PHOTOS_DIR ("<recordId>/<filename>") и PHOTOS_TRASH_DIR
// ("<trashName>/<filename>" -> ключ "trash/<trashName>/<filename>") с теми же
// относительными путями, что уже лежат в record_photos.file_path — после
// миграции рантайм ничего переименовывать не должен.
//
// Идемпотентный: уже существующие в S3 объекты пропускает, можно перезапускать.
// Локальные файлы НЕ удаляет — это отдельный ручной шаг после проверки.
//
// Запуск (на сервере, из папки бэкенда — там же лежит .env):
//   node scripts/migrate-photos-to-s3.js
import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { objectExists, putPhoto } from "../src/s3.js";

const PHOTOS_DIR = process.env.PHOTOS_DIR || "/opt/uchet/uploads/photos";
const PHOTOS_TRASH_DIR = process.env.PHOTOS_TRASH_DIR || "/opt/uchet/uploads/photos-trash";

const CONTENT_TYPE_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function contentTypeFor(filename) {
  return CONTENT_TYPE_BY_EXT[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

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

async function migrateDir(directory, keyPrefix, stats) {
  if (!fs.existsSync(directory)) {
    console.log(`Пропускаю ${directory} — директория не существует`);
    return;
  }
  const relativePaths = await walk(directory);
  console.log(`${directory}: найдено ${relativePaths.length} файлов`);

  for (const relativePath of relativePaths) {
    const key = keyPrefix ? `${keyPrefix}/${relativePath}` : relativePath;
    stats.total++;
    try {
      if (await objectExists(key)) {
        stats.skipped++;
      } else {
        const buffer = await fsp.readFile(path.join(directory, ...relativePath.split("/")));
        await putPhoto(key, buffer, contentTypeFor(relativePath));
        stats.uploaded++;
      }
    } catch (err) {
      stats.errors.push({ key, message: err.message });
    }

    if (stats.total % 50 === 0) {
      console.log(
        `...прогресс: обработано ${stats.total}, залито ${stats.uploaded}, пропущено ${stats.skipped}, ошибок ${stats.errors.length}`,
      );
    }
  }
}

async function main() {
  const stats = { total: 0, uploaded: 0, skipped: 0, errors: [] };

  await migrateDir(PHOTOS_DIR, "", stats);
  // PHOTOS_TRASH_DIR устроен как <trashName>/<filename> — в S3 это должно
  // стать "trash/<trashName>/<filename>".
  await migrateDir(PHOTOS_TRASH_DIR, "trash", stats);

  console.log("\n--- Итог ---");
  console.log(`Всего файлов: ${stats.total}`);
  console.log(`Залито: ${stats.uploaded}`);
  console.log(`Пропущено (уже в S3): ${stats.skipped}`);
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
  console.error("Миграция упала с необработанной ошибкой:", err);
  process.exitCode = 1;
});
