import { Router } from "express";
import path from "node:path";
import { pool } from "../db.js";
import { requireAuth, isAdminLike } from "../auth.js";
import { asyncHandler } from "../async-handler.js";
import { photoUpload, photoUploadErrorHandler, savePhotoFile, redirectToPhoto } from "../photo-storage.js";
import { ACTIVE_OBJECT_PHOTOS, objectPhotoSourceCte, moscowToday, isIsoDate } from "../object-photo-source.js";

// Фото-отчёты по объекту: мастер загружает фото по объекту за день — без вида
// работ, сотрудников и объёмов. Это НЕ записи: на суммы, статусы,
// work-summary и GET /api/records не влияют.
//
// Файлы в S3: "object-photos/<objectId>/<uuid>.jpg" (+ thumb_), в БД —
// без S3_PREFIX, как record_photos.file_path. Префикс не пересекается с
// ключами фото записей "<recordId>/" и корзиной "trash/" (movePhotosToTrash).
//
// Видят все авторизованные (как фото записей); загружает любой авторизованный;
// менять дату/комментарий и удалять — автор, curator, admin (как canModify
// записей). Удаление мягкое (deleted_at), файлы в S3 остаются. Аудит-лога
// нет — только логи в консоль.

const REPORT_PHOTOS_MAX_PER_UPLOAD = 10;
const PHOTO_DATE_MAX_AGE_DAYS = 30;

const upload = photoUpload(REPORT_PHOTOS_MAX_PER_UPLOAD);
const handlePhotoUploadErrors = photoUploadErrorHandler(REPORT_PHOTOS_MAX_PER_UPLOAD);

// Возвращает текст ошибки или null. Дата — YYYY-MM-DD, не в будущем и не
// старше 30 дней относительно сегодняшнего дня по Москве.
function photoDateError(value) {
  if (!isIsoDate(value)) return "photo_date must be YYYY-MM-DD";
  const today = moscowToday();
  if (value > today) return "photo_date cannot be in the future";
  const min = new Date(`${today}T00:00:00Z`);
  min.setUTCDate(min.getUTCDate() - PHOTO_DATE_MAX_AGE_DAYS);
  if (value < min.toISOString().slice(0, 10)) {
    return `photo_date cannot be older than ${PHOTO_DATE_MAX_AGE_DAYS} days`;
  }
  return null;
}

function normalizeComment(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function canModifyReportPhoto(photo, user) {
  return isAdminLike(user) || photo.user_id === user.id;
}

const PHOTO_COLUMNS = `op.id, op.object_id, op.file_path, op.comment, op.photo_date, op.created_at,
       op.user_id, u.full_name AS author_name`;

// Неудалённое фото-отчёта по id (или null).
async function loadReportPhoto(photoId) {
  if (!/^\d+$/.test(String(photoId))) return null;
  const { rows } = await pool.query(
    `SELECT ${PHOTO_COLUMNS}
       FROM ${ACTIVE_OBJECT_PHOTOS} op LEFT JOIN users u ON u.id = op.user_id
      WHERE op.id = $1`,
    [photoId],
  );
  return rows[0] || null;
}

// ---- /api/objects/:id/report-photos ----

export const objectReportPhotosRouter = Router();

objectReportPhotosRouter.post(
  "/:id/report-photos",
  requireAuth,
  upload,
  handlePhotoUploadErrors,
  asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const { rows: objectRows } = await pool.query(`SELECT id FROM objects WHERE id = $1`, [req.params.id]);
    if (!objectRows[0]) return res.status(404).json({ error: "not found" });
    const objectId = objectRows[0].id;

    const photoDate = req.body?.photo_date ? String(req.body.photo_date) : moscowToday();
    const dateError = photoDateError(photoDate);
    if (dateError) return res.status(400).json({ error: dateError });
    const comment = normalizeComment(req.body?.comment);

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });

    const dir = `object-photos/${objectId}`;
    const saved = [];
    const skipped = [];
    for (const file of files) {
      const fname = await savePhotoFile(dir, file);
      if (fname) saved.push(`${dir}/${fname}`);
      else skipped.push(file.originalname);
    }
    if (!saved.length) return res.status(400).json({ error: "no valid image files", skipped });

    // Комментарий — один на всю пачку, пишется в каждую строку.
    const { rows } = await pool.query(
      `WITH inserted AS (
         INSERT INTO object_photos (object_id, user_id, file_path, comment, photo_date)
         SELECT $1, $2, fp, $3, $4 FROM unnest($5::text[]) WITH ORDINALITY AS t(fp, ord)
         ORDER BY ord
         RETURNING *
       )
       SELECT ${PHOTO_COLUMNS} FROM inserted op LEFT JOIN users u ON u.id = op.user_id
        ORDER BY op.id`,
      [objectId, req.user.id, comment, photoDate, saved],
    );
    console.log(
      `Фото-отчёт: объект ${objectId}, пользователь ${req.user.id}, дата ${photoDate}, ` +
        `загружено ${rows.length}, пропущено ${skipped.length}`,
    );
    res.status(201).json({ photos: rows, skipped });
  }),
);

objectReportPhotosRouter.get(
  "/:id/report-photos",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
      return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    }
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const { rows: objectRows } = await pool.query(`SELECT id FROM objects WHERE id = $1`, [req.params.id]);
    if (!objectRows[0]) return res.status(404).json({ error: "not found" });

    const params = [req.params.id];
    if (from) params.push(from);
    if (to) params.push(to);
    const { rows } = await pool.query(
      `WITH ${objectPhotoSourceCte({
        objectParam: "$1",
        fromParam: from ? "$2" : null,
        toParam: to ? `$${params.length}` : null,
        sources: ["report"],
      })}
       SELECT s.source_id AS id, s.object_id, s.file_path, s.comment, s.photo_date,
              s.uploaded_at AS created_at, s.user_id, u.full_name AS author_name
         FROM object_photo_source s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.photo_date DESC, s.uploaded_at DESC, s.source_id DESC`,
      params,
    );
    res.json({ photos: rows });
  }),
);

// ---- /api/object-photos/:photoId ----

export const objectPhotosRouter = Router();

objectPhotosRouter.get(
  "/:photoId/file",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await loadReportPhoto(req.params.photoId);
    if (!photo) return res.status(404).json({ error: "not found" });
    await redirectToPhoto(
      res,
      path.posix.dirname(photo.file_path),
      path.posix.basename(photo.file_path),
      req.query.thumb === "1",
    );
  }),
);

objectPhotosRouter.patch(
  "/:photoId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await loadReportPhoto(req.params.photoId);
    if (!photo) return res.status(404).json({ error: "not found" });
    if (!canModifyReportPhoto(photo, req.user)) return res.status(403).json({ error: "forbidden" });

    const body = req.body || {};
    const hasDate = body.photo_date !== undefined;
    const hasComment = body.comment !== undefined;
    if (!hasDate && !hasComment) return res.status(400).json({ error: "nothing to update" });
    if (hasDate) {
      const dateError = photoDateError(body.photo_date);
      if (dateError) return res.status(400).json({ error: dateError });
    }

    const { rowCount } = await pool.query(
      `UPDATE object_photos
          SET photo_date = CASE WHEN $2 THEN $3::date ELSE photo_date END,
              comment = CASE WHEN $4 THEN $5 ELSE comment END
        WHERE id = $1 AND deleted_at IS NULL`,
      [photo.id, hasDate, hasDate ? body.photo_date : null, hasComment, hasComment ? normalizeComment(body.comment) : null],
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    console.log(`Фото-отчёт ${photo.id}: изменён пользователем ${req.user.id}`);
    res.json(await loadReportPhoto(photo.id));
  }),
);

objectPhotosRouter.delete(
  "/:photoId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await loadReportPhoto(req.params.photoId);
    if (!photo) return res.status(404).json({ error: "not found" });
    if (!canModifyReportPhoto(photo, req.user)) return res.status(403).json({ error: "forbidden" });

    // Мягкое удаление: файл в S3 не трогаем.
    const { rowCount } = await pool.query(
      `UPDATE object_photos SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`,
      [photo.id, req.user.id],
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    console.log(`Фото-отчёт ${photo.id} (объект ${photo.object_id}) удалён пользователем ${req.user.id}`);
    res.json({ deleted: photo.id });
  }),
);
