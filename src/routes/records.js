import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import sharp from "sharp";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { insertAuditLog } from "../audit.js";
import { asyncHandler } from "../async-handler.js";

const PHOTOS_DIR = process.env.PHOTOS_DIR || "/opt/uchet/uploads/photos";
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// Корзина для фото удалённых записей: при удалении записи её папка с фото не
// стирается сразу, а переносится сюда — это нужно, чтобы аудит-лог мог
// восстановить фото вместе с записью. Живёт до тех пор, пока кто-то явно не
// восстановит запись; чистка старой корзины — отдельная задача на будущее.
const PHOTOS_TRASH_DIR = process.env.PHOTOS_TRASH_DIR || "/opt/uchet/uploads/photos-trash";
fs.mkdirSync(PHOTOS_TRASH_DIR, { recursive: true });

export function movePhotosToTrash(recordId) {
  const srcDir = path.join(PHOTOS_DIR, String(recordId));
  if (!fs.existsSync(srcDir)) return null;
  const trashName = `${recordId}-${Date.now()}`;
  const destDir = path.join(PHOTOS_TRASH_DIR, trashName);
  try {
    fs.renameSync(srcDir, destDir);
  } catch {
    // На случай, если PHOTOS_DIR и PHOTOS_TRASH_DIR на разных ФС (EXDEV) — копируем и чистим исходник.
    fs.cpSync(srcDir, destDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
  return trashName;
}

export function restorePhotosFromTrash(recordId, trashName) {
  if (!trashName) return false;
  const srcDir = path.join(PHOTOS_TRASH_DIR, trashName);
  if (!fs.existsSync(srcDir)) return false;
  const destDir = path.join(PHOTOS_DIR, String(recordId));
  try {
    fs.renameSync(srcDir, destDir);
  } catch {
    fs.cpSync(srcDir, destDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
  return true;
}

// Проверяет, жив ли ещё файл фото на диске по относительному пути вида
// "<recordId>/<filename>" (так, как он хранится в record_photos.file_path).
// Нужно для restore из audit-log: индивидуальное удаление одной фотографии
// (DELETE /:id/photos/:filename) стирает файл сразу, без корзины — в отличие
// от удаления всей записи. Если такую фотографию восстанавливать из старого
// снимка "до", получится ссылка на несуществующий файл (404 при просмотре).
export function photoFileExists(relativePath) {
  return fs.existsSync(path.join(PHOTOS_DIR, relativePath));
}

const PHOTO_MAX_PER_RECORD = 30;
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_FILE_SIZE_BYTES, files: PHOTO_MAX_PER_RECORD },
});

// Превращает ошибки multer (файл/пакет превышают лимит, слишком много файлов
// и т.п.) в понятный ответ вместо общего "internal server error" из
// глобального обработчика в app.js — раньше пользователь не мог понять,
// что именно пошло не так, и повторная попытка с тем же файлом заведомо
// повторяла ту же ошибку.
function handlePhotoUploadErrors(err, _req, res, next) {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    const mb = Math.round(PHOTO_MAX_FILE_SIZE_BYTES / (1024 * 1024));
    return res.status(413).json({ error: `файл превышает максимальный размер ${mb} МБ` });
  }
  if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: `максимум ${PHOTO_MAX_PER_RECORD} фото за раз` });
  }
  console.error("Ошибка загрузки фото:", err);
  return res.status(500).json({ error: "не удалось загрузить фото" });
}

export const recordsRouter = Router();

// Автор записи или curator/admin — тот, кто может её править/удалять.
function canModify(record, user) {
  if (!user) return false;
  if (user.role === "admin" || user.role === "curator") return true;
  return record.created_by_user_id === user.id;
}

// Пока запись в статусе "draft" (Незавершено), её видит только тот, кто её
// начал ("Кто подал") — включая куратора/админа. После перехода в "done"
// (Записано) запись становится видна всем.
function canView(record, user) {
  if (!user) return false;
  if (record.status !== "draft") return true;
  return record.created_by_user_id === user.id;
}

// Загружает сразу несколько записей (records + items + shares + photos) за
// фиксированное число запросов, а не N+1 на каждую отдельно. Раньше
// GET /api/records с лимитом на страницу (до 1000!) делал по записи минимум
// 3 запроса плюс ещё один на КАЖДУЮ позицию (shares) — то есть страница с
// реальным объёмом данных могла упереться в сотни-тысячи последовательных
// запросов при всего 10 соединениях в пуле (см. db.js), замедляя всё
// приложение сразу для всех пользователей на время построения списка.
async function loadRecordsByIds(ids) {
  if (!ids.length) return [];
  const numericIds = ids.map(Number);

  const { rows: records } = await pool.query(`SELECT * FROM records WHERE id = ANY($1)`, [
    numericIds,
  ]);
  if (!records.length) return [];

  const { rows: items } = await pool.query(
    `SELECT * FROM record_items WHERE record_id = ANY($1) ORDER BY record_id, sort_order`,
    [numericIds],
  );
  const itemIds = items.map((i) => i.id);
  const { rows: shares } = itemIds.length
    ? await pool.query(
        `SELECT record_item_id, employee_name, qty FROM record_item_shares WHERE record_item_id = ANY($1)`,
        [itemIds],
      )
    : { rows: [] };
  const { rows: photos } = await pool.query(
    `SELECT record_id, file_path FROM record_photos WHERE record_id = ANY($1) ORDER BY record_id, sort_order`,
    [numericIds],
  );

  const sharesByItemId = new Map();
  for (const s of shares) {
    if (!sharesByItemId.has(s.record_item_id)) sharesByItemId.set(s.record_item_id, []);
    sharesByItemId.get(s.record_item_id).push({ employee_name: s.employee_name, qty: s.qty });
  }
  const itemsByRecordId = new Map();
  for (const item of items) {
    item.shares = sharesByItemId.get(item.id) || [];
    if (!itemsByRecordId.has(item.record_id)) itemsByRecordId.set(item.record_id, []);
    itemsByRecordId.get(item.record_id).push(item);
  }
  const photosByRecordId = new Map();
  for (const p of photos) {
    if (!photosByRecordId.has(p.record_id)) photosByRecordId.set(p.record_id, []);
    photosByRecordId.get(p.record_id).push(p.file_path);
  }

  // Порядок результата совпадает с порядком id на входе — важно для GET /,
  // где id уже отсортированы нужным образом (ORDER BY id DESC) до этого вызова.
  const byId = new Map(records.map((r) => [r.id, r]));
  return numericIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((record) => ({
      ...record,
      items: itemsByRecordId.get(record.id) || [],
      photos: photosByRecordId.get(record.id) || [],
    }));
}

export async function loadFullRecord(recordId) {
  const [record] = await loadRecordsByIds([recordId]);
  return record || null;
}

recordsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { object, employee, from, to, limit = 30, offset = 0 } = req.query;
    const clauses = [];
    const params = [];

    if (object) {
      params.push(object);
      clauses.push(`object_name_raw = $${params.length}`);
    }
    if (employee) {
      params.push(employee);
      clauses.push(`$${params.length} = ANY(employees)`);
    }
    if (from) {
      params.push(from);
      clauses.push(`date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      clauses.push(`date <= $${params.length}`);
    }

    // Черновики (status = 'draft') видны только их автору — остальным (в т.ч.
    // куратору/админу) они не показываются, пока не проставлен статус "done".
    params.push(req.user.id);
    clauses.push(`(status <> 'draft' OR created_by_user_id = $${params.length})`);

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM records ${where}`, params);
    const total = Number(countRows[0].count);

    const lim = Math.max(1, Math.min(Number(limit) || 30, 1000));
    const off = Math.max(0, Number(offset) || 0);
    params.push(lim, off);
    const { rows } = await pool.query(
      `SELECT id FROM records ${where} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const records = await loadRecordsByIds(rows.map((r) => r.id));
    res.json({ records, total, offset: off, has_more: off + records.length < total });
  }),
);

recordsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const record = await loadFullRecord(req.params.id);
    if (!record) return res.status(404).json({ error: "not found" });
    // Не раскрываем даже факт существования чужого черновика.
    if (!canView(record, req.user)) return res.status(404).json({ error: "not found" });
    res.json(record);
  }),
);

// Возвращает { normalized, total, error } — error не null, если хотя бы одна
// позиция имеет некорректные qty/price (не число, отрицательное, NaN/Infinity).
// Раньше это никак не проверялось: Number(item.qty) * Number(item.price) от
// произвольных значений могло дать NaN/отрицательную сумму, которая тихо
// уходила в БД — колонки numeric формально это пропускают.
function computeItemsAndTotal(items) {
  let total = 0;
  let error = null;
  const normalized = (items || []).map((item) => {
    const qty = Number(item.qty);
    const price = Number(item.price);
    if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(price) || price < 0) {
      error = `invalid qty/price for item "${item.name ?? ""}"`;
    }
    const sum = qty * price;
    total += sum;
    return { ...item, sum };
  });
  return { normalized, total, error };
}

recordsRouter.post("/", requireAuth, async (req, res) => {
  const { object_id, object_name, employees = [], date, items, comment = "", status = "done" } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });
  if (status === "done" && !object_name) {
    return res.status(400).json({ error: "object is required to complete a record" });
  }
  const { normalized, total, error } = computeItemsAndTotal(items);
  if (error) return res.status(400).json({ error });
  if (status === "done" && !normalized.length) return res.status(400).json({ error: "no valid items" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO records (object_id, object_name_raw, employees, claimed_by, created_by_user_id, date, total, comment, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [object_id || null, object_name || "", employees, req.user.full_name, req.user.id, date, total, comment, status],
    );
    const recordId = rows[0].id;

    for (let i = 0; i < normalized.length; i++) {
      const item = normalized[i];
      const { rows: itemRows } = await client.query(
        `INSERT INTO record_items (record_id, name, unit, qty, price, sum, manual, sort_order, work_type_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [recordId, item.name, item.unit, item.qty, item.price, item.sum, !!item.manual, i, item.work_type_id || null],
      );
      const itemId = itemRows[0].id;
      for (const share of item.shares || []) {
        await client.query(
          `INSERT INTO record_item_shares (record_item_id, employee_name, qty) VALUES ($1,$2,$3)`,
          [itemId, share.employee, share.qty],
        );
      }
    }

    await client.query("COMMIT");
    const full = await loadFullRecord(recordId);
    await insertAuditLog(pool, {
      entityType: "record",
      entityId: recordId,
      action: "create",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: null,
      after: full,
    });
    res.status(201).json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to create record" });
  } finally {
    client.release();
  }
});

recordsRouter.put("/:id", requireAuth, async (req, res) => {
  const existing = await loadFullRecord(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  if (!canModify(existing, req.user)) return res.status(403).json({ error: "forbidden" });

  const { object_id, object_name, employees = [], date, items, comment = "", status } = req.body || {};
  const { normalized, total, error } = computeItemsAndTotal(items);
  if (error) return res.status(400).json({ error });
  if ((status || existing.status) === "done" && !normalized.length) {
    return res.status(400).json({ error: "no valid items" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE records SET object_id=$1, object_name_raw=$2, employees=$3, date=$4, total=$5,
         comment=$6, status=COALESCE($7, status), modified_by=$8, modified_by_user_id=$9, modified_at=now()
       WHERE id=$10`,
      [object_id || null, object_name || "", employees, date, total, comment, status, req.user.full_name, req.user.id, req.params.id],
    );
    await client.query(`DELETE FROM record_items WHERE record_id = $1`, [req.params.id]);
    for (let i = 0; i < normalized.length; i++) {
      const item = normalized[i];
      const { rows: itemRows } = await client.query(
        `INSERT INTO record_items (record_id, name, unit, qty, price, sum, manual, sort_order, work_type_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.params.id, item.name, item.unit, item.qty, item.price, item.sum, !!item.manual, i, item.work_type_id || null],
      );
      const itemId = itemRows[0].id;
      for (const share of item.shares || []) {
        await client.query(
          `INSERT INTO record_item_shares (record_item_id, employee_name, qty) VALUES ($1,$2,$3)`,
          [itemId, share.employee, share.qty],
        );
      }
    }
    await client.query("COMMIT");
    const full = await loadFullRecord(req.params.id);
    await insertAuditLog(pool, {
      entityType: "record",
      entityId: Number(req.params.id),
      action: "update",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: existing,
      after: full,
    });
    res.json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to update record" });
  } finally {
    client.release();
  }
});

recordsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await loadFullRecord(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: "forbidden" });

    // Явно удаляем зависимые строки перед самой записью, в одной транзакции.
    // Раньше здесь был голый DELETE FROM records — если на уровне БД для
    // record_items нет ON DELETE CASCADE, это падает нарушением внешнего
    // ключа, а без try/catch/asyncHandler запрос зависал без ответа вместо
    // понятной ошибки (реально воспроизвелось при тестировании на схеме без
    // явного CASCADE — на проде, если там CASCADE есть, эти DELETE безвредны).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM record_item_shares WHERE record_item_id IN (SELECT id FROM record_items WHERE record_id = $1)`,
        [req.params.id],
      );
      await client.query(`DELETE FROM record_items WHERE record_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM record_photos WHERE record_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM records WHERE id = $1`, [req.params.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Фото не стираем сразу, а уносим в корзину — так их можно вернуть при восстановлении.
    let trashName = null;
    try {
      trashName = movePhotosToTrash(req.params.id);
    } catch (err) {
      // Права/диск подвели — запись всё равно уже удалена из БД, не роняем
      // процесс из-за отдельно взятой файловой операции с фото.
      console.error(`Не удалось перенести фото записи ${req.params.id} в корзину:`, err);
    }

    await insertAuditLog(pool, {
      entityType: "record",
      entityId: Number(req.params.id),
      action: "delete",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: { ...existing, _photos_trash_dir: trashName },
      after: null,
    });

    res.json({ deleted: Number(req.params.id) });
  }),
);

// ---- Фото ----

recordsRouter.post(
  "/:id/photos",
  requireAuth,
  upload.array("photos", PHOTO_MAX_PER_RECORD),
  handlePhotoUploadErrors,
  asyncHandler(async (req, res) => {
    const existing = await loadFullRecord(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: "forbidden" });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });
    if (existing.photos.length + files.length > PHOTO_MAX_PER_RECORD) {
      return res.status(400).json({ error: `max ${PHOTO_MAX_PER_RECORD} photos per record` });
    }

    const dir = path.join(PHOTOS_DIR, String(req.params.id));
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Не даём одной ошибке прав/диска положить весь процесс для всех
      // пользователей — раньше необработанное исключение здесь роняло
      // uchet-backend.service целиком (см. systemd restart counter).
      console.error(`Не удалось создать папку под фото записи ${req.params.id}:`, err);
      return res.status(500).json({ error: "failed to create photos directory" });
    }

    const saved = [];
    const skipped = []; // имена файлов с неподдерживаемым расширением/не
    // сохранившихся — раньше пропускались через continue молча, и
    // пользователь не понимал, почему именно этого фото нет в записи
    // ("не все фото присутствуют")
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        skipped.push(file.originalname);
        continue;
      }
      const fname = `${crypto.randomUUID().replace(/-/g, "")}.jpg`;
      const destPath = path.join(dir, fname);
      try {
        await sharp(file.buffer)
          .rotate() // авто-поворот по EXIF
          .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toFile(destPath);
      } catch {
        try {
          fs.writeFileSync(destPath, file.buffer); // если sharp не смог разобрать формат — сохраняем как есть
        } catch (writeErr) {
          console.error(`Не удалось сохранить фото ${fname} записи ${req.params.id}:`, writeErr);
          skipped.push(file.originalname);
          continue; // пропускаем это фото, но не роняем весь запрос/процесс
        }
      }
      saved.push(fname);
      await pool.query(
        `INSERT INTO record_photos (record_id, file_path, sort_order) VALUES ($1,$2,$3)`,
        [req.params.id, `${req.params.id}/${fname}`, existing.photos.length + saved.length - 1],
      );
    }

    if (!saved.length) return res.status(400).json({ error: "no valid image files" });
    const full = await loadFullRecord(req.params.id);
    res.status(201).json({ photos: full.photos, added: saved, skipped });
  }),
);

recordsRouter.get(
  "/:id/photos/:filename",
  requireAuth,
  asyncHandler(async (req, res) => {
    const record = await loadFullRecord(req.params.id);
    if (!record || !canView(record, req.user)) return res.status(404).json({ error: "not found" });

    const safeName = path.basename(req.params.filename);
    const filePath = path.join(PHOTOS_DIR, String(req.params.id), safeName);
    if (!filePath.startsWith(PHOTOS_DIR) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "not found" });
    }
    res.sendFile(filePath);
  }),
);

recordsRouter.delete(
  "/:id/photos/:filename",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await loadFullRecord(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: "forbidden" });

    const safeName = path.basename(req.params.filename);
    await pool.query(`DELETE FROM record_photos WHERE record_id = $1 AND file_path = $2`, [
      req.params.id,
      `${req.params.id}/${safeName}`,
    ]);
    fs.rm(path.join(PHOTOS_DIR, String(req.params.id), safeName), () => {});
    res.json({ deleted: safeName });
  }),
);
