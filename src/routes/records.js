import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import sharp from "sharp";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { insertAuditLog } from "../audit.js";

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

const PHOTO_MAX_PER_RECORD = 12;
const PHOTO_MAX_DIMENSION = 1920;
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: PHOTO_MAX_PER_RECORD },
});

export const recordsRouter = Router();

// Автор записи или curator/admin — тот, кто может её править/удалять.
function canModify(record, user) {
  if (!user) return false;
  if (user.role === "admin" || user.role === "curator") return true;
  return record.created_by_user_id === user.id;
}

export async function loadFullRecord(recordId) {
  const { rows: recRows } = await pool.query(`SELECT * FROM records WHERE id = $1`, [recordId]);
  const record = recRows[0];
  if (!record) return null;

  const { rows: items } = await pool.query(
    `SELECT * FROM record_items WHERE record_id = $1 ORDER BY sort_order`,
    [recordId],
  );
  for (const item of items) {
    const { rows: shares } = await pool.query(
      `SELECT employee_name, qty FROM record_item_shares WHERE record_item_id = $1`,
      [item.id],
    );
    item.shares = shares;
  }
  const { rows: photos } = await pool.query(
    `SELECT file_path FROM record_photos WHERE record_id = $1 ORDER BY sort_order`,
    [recordId],
  );

  return { ...record, items, photos: photos.map((p) => p.file_path) };
}

recordsRouter.get("/", requireAuth, async (req, res) => {
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

  const records = await Promise.all(rows.map((r) => loadFullRecord(r.id)));
  res.json({ records, total, offset: off, has_more: off + records.length < total });
});

recordsRouter.get("/:id", requireAuth, async (req, res) => {
  const record = await loadFullRecord(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(record);
});

function computeItemsAndTotal(items) {
  let total = 0;
  const normalized = (items || []).map((item) => {
    const sum = Number(item.qty) * Number(item.price);
    total += sum;
    return { ...item, sum };
  });
  return { normalized, total };
}

recordsRouter.post("/", requireAuth, async (req, res) => {
  const { object_id, object_name, employees = [], date, items, comment = "", status = "done" } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });
  if (status === "done" && !object_name) {
    return res.status(400).json({ error: "object is required to complete a record" });
  }
  const { normalized, total } = computeItemsAndTotal(items);
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
  const { normalized, total } = computeItemsAndTotal(items);
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

recordsRouter.delete("/:id", requireAuth, async (req, res) => {
  const existing = await loadFullRecord(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  if (!canModify(existing, req.user)) return res.status(403).json({ error: "forbidden" });

  await pool.query(`DELETE FROM records WHERE id = $1`, [req.params.id]);
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
});

// ---- Фото ----

recordsRouter.post("/:id/photos", requireAuth, upload.array("photos", PHOTO_MAX_PER_RECORD), async (req, res) => {
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
  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
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
  res.status(201).json({ photos: full.photos, added: saved });
});

recordsRouter.get("/:id/photos/:filename", requireAuth, (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(PHOTOS_DIR, String(req.params.id), safeName);
  if (!filePath.startsWith(PHOTOS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "not found" });
  }
  res.sendFile(filePath);
});

recordsRouter.delete("/:id/photos/:filename", requireAuth, async (req, res) => {
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
});
