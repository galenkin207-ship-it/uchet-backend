// Общая обработка загружаемых фото — для фото записей (routes/records.js) и
// фото-отчётов по объекту (routes/object-photos.js). Вынесено из records.js
// без изменения поведения: те же лимиты, расширения, sharp-пайплайн, превью
// и fallback. Пути — относительные (без S3_PREFIX), см. s3.js.
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import sharp from "sharp";
import { putPhoto, getPresignedUrl, objectExists } from "./s3.js";

const PHOTO_MAX_DIMENSION = 1920;
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
// ВАЖНО: должно совпадать с PHOTO_MAX_RAW_SIZE_BYTES на фронтенде
// (pixel-perfect-view-518/src/components/app/record-form.tsx). Раньше тут
// стояло 15 МБ, а на фронтенде клиентская проверка пропускала файлы до 30 МБ —
// несжимаемые HEIC/JPEG с современных телефонов (48 Мп камера, панорамы)
// проходили клиентскую проверку, но падали здесь с невнятной 500-й ошибкой,
// а заодно из-за multer.array() валили ВЕСЬ пакет фото в этом запросе, включая
// остальные нормальные снимки — отсюда жалобы "не все фото загрузились".
const PHOTO_MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;

// multer-мидлвар для поля "photos" (до maxFiles файлов, в памяти).
export function photoUpload(maxFiles) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PHOTO_MAX_FILE_SIZE_BYTES, files: maxFiles },
  }).array("photos", maxFiles);
}

// Превращает ошибки multer (файл/пакет превышают лимит, слишком много файлов
// и т.п.) в понятный ответ вместо общего "internal server error" из
// глобального обработчика в app.js — раньше пользователь не мог понять,
// что именно пошло не так, и повторная попытка с тем же файлом заведомо
// повторяла ту же ошибку.
export function photoUploadErrorHandler(maxFiles) {
  return function handlePhotoUploadErrors(err, _req, res, next) {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      const mb = Math.round(PHOTO_MAX_FILE_SIZE_BYTES / (1024 * 1024));
      return res.status(413).json({ error: `файл превышает максимальный размер ${mb} МБ` });
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: `максимум ${maxFiles} фото за раз` });
    }
    console.error("Ошибка загрузки фото:", err);
    return res.status(500).json({ error: "не удалось загрузить фото" });
  };
}

// Сохраняет один загруженный multer-файл в S3 как "<dir>/<uuid>.jpg" (+ превью
// "<dir>/thumb_<uuid>.jpg"). Возвращает имя файла, либо null, если файл
// пропущен (неподдерживаемое расширение или не удалось сохранить) — раньше
// такие пропускались молча, и пользователь не понимал, почему именно этого
// фото нет ("не все фото присутствуют").
export async function savePhotoFile(dir, file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return null;
  const fname = `${crypto.randomUUID().replace(/-/g, "")}.jpg`;
  let resized = false;
  try {
    const buffer = await sharp(file.buffer)
      .rotate() // авто-поворот по EXIF
      .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    await putPhoto(`${dir}/${fname}`, buffer, "image/jpeg");
    resized = true;
  } catch {
    try {
      // если sharp не смог разобрать формат — сохраняем как есть, с исходным content-type
      await putPhoto(`${dir}/${fname}`, file.buffer, file.mimetype || "application/octet-stream");
    } catch (writeErr) {
      console.error(`Не удалось сохранить фото ${fname} в ${dir}:`, writeErr);
      return null; // пропускаем это фото, но не роняем весь запрос/процесс
    }
  }
  // Превью генерируем только когда основной sharp-пайплайн отработал —
  // в fallback-ветке (сохранение as-is) исходник может быть в формате,
  // который sharp не разобрал, так что превью для него всё равно не выйдет.
  if (resized) {
    try {
      const thumbBuffer = await sharp(file.buffer)
        .rotate()
        .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 68 })
        .toBuffer();
      await putPhoto(`${dir}/thumb_${fname}`, thumbBuffer, "image/jpeg");
    } catch (thumbErr) {
      console.error(`Не удалось сгенерировать превью для фото ${fname} в ${dir}:`, thumbErr);
    }
  }
  return fname;
}

// 302 на presigned URL фото "<dir>/<name>" (с ?thumb=1 — на превью, если оно
// есть, иначе на оригинал); 404, если объекта в S3 нет.
export async function redirectToPhoto(res, dir, name, thumb) {
  const safeName = path.basename(name);
  if (thumb) {
    const thumbPath = `${dir}/thumb_${safeName}`;
    if (await objectExists(thumbPath)) {
      return res.redirect(302, await getPresignedUrl(thumbPath));
    }
  }
  const relativePath = `${dir}/${safeName}`;
  if (!(await objectExists(relativePath))) {
    return res.status(404).json({ error: "not found" });
  }
  res.redirect(302, await getPresignedUrl(relativePath));
}
