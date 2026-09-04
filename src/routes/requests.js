import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { sendPushToRole, sendPushToUser } from "../push-notify.js";
import { insertAuditLog } from "../audit.js";
import { asyncHandler } from "../async-handler.js";
import { upsertWorkTypeByName } from "./directories.js";

export const requestsRouter = Router();

// Ищем id пользователя по ФИО — используется только как fallback для старых
// заявок/сообщений, у которых почему-то не заполнен user_id (например,
// пользователь с тех пор был удалён и submitted_by_user_id стал NULL через
// ON DELETE SET NULL). Для всего нового — используется user_id напрямую,
// без поиска по имени (см. миграцию 013_add_requests_submitted_by_user_id.sql).
async function findUserIdByName(fullName) {
  if (!fullName) return null;
  const { rows } = await pool.query(`SELECT id FROM users WHERE full_name = $1 LIMIT 1`, [
    fullName,
  ]);
  return rows[0]?.id ?? null;
}

// Полный снимок заявки вместе с перепиской — используется и для GET /:id-подобной
// логики, и как снимок "до"/"после" для аудит-лога.
export async function loadFullRequest(id) {
  const { rows } = await pool.query(
    `SELECT r.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', c.id, 'author', c.author, 'author_user_id', c.author_user_id,
            'text', c.text, 'created_at', c.created_at, 'edited_at', c.edited_at
          ) ORDER BY c.created_at
        ) FILTER (WHERE c.id IS NOT NULL),
        '[]'
      ) AS comments
    FROM requests r
    LEFT JOIN request_comments c ON c.request_id = r.id
    WHERE r.id = $1
    GROUP BY r.id`,
    [id],
  );
  return rows[0] || null;
}

requestsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // КРИТИЧНО: раньше этот эндпоинт отдавал ВСЕ заявки и ВСЮ переписку по ним
    // любому авторизованному пользователю без исключений — видимость "прораб
    // видит только свои заявки" была реализована ИСКЛЮЧИТЕЛЬНО на клиенте
    // (фильтром по ФИО во фронтенде). Любой прораб, обратившись к этому
    // эндпоинту напрямую (DevTools/curl со своей cookie), получал приватную
    // переписку всех остальных прорабов с админом/куратором.
    // Основная проверка — по submitted_by_user_id; fallback на ФИО — только
    // для старых заявок, у которых он не заполнен (см. миграцию 013).
    const isForeman = req.user.role === "user";
    const { rows } = await pool.query(
      `
      SELECT r.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', c.id, 'author', c.author, 'author_user_id', c.author_user_id,
              'text', c.text, 'created_at', c.created_at, 'edited_at', c.edited_at
            )
            ORDER BY c.created_at
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'
        ) AS comments
      FROM requests r
      LEFT JOIN request_comments c ON c.request_id = r.id
      ${isForeman ? "WHERE (r.submitted_by_user_id = $1 OR (r.submitted_by_user_id IS NULL AND r.submitted_by = $2))" : ""}
      GROUP BY r.id
      ORDER BY r.id DESC
    `,
      isForeman ? [req.user.id, req.user.full_name] : [],
    );
    res.json(rows);
  }),
);

requestsRouter.post(
  "/:id/comments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });

    const { rows: reqRows } = await pool.query(`SELECT id FROM requests WHERE id = $1`, [
      req.params.id,
    ]);
    if (!reqRows[0]) return res.status(404).json({ error: "request not found" });

    const { rows } = await pool.query(
      `INSERT INTO request_comments (request_id, author, author_user_id, text)
       VALUES ($1,$2,$3,$4) RETURNING id, author, author_user_id, text, created_at, edited_at`,
      [req.params.id, req.user.full_name, req.user.id, String(text).trim()],
    );
    res.status(201).json(rows[0]);

    // Уведомляем "другую сторону" переписки — не самого отправителя.
    const { rows: reqInfo } = await pool.query(
      `SELECT submitted_by, submitted_by_user_id, text FROM requests WHERE id = $1`,
      [req.params.id],
    );
    const parent = reqInfo[0];
    if (parent) {
      const payload = {
        title: `${req.user.full_name}: новое сообщение`,
        body: String(text).trim(),
        url: `/messages?request=${req.params.id}`,
      };
      const isParentAuthor = parent.submitted_by_user_id != null
        ? parent.submitted_by_user_id === req.user.id
        : parent.submitted_by === req.user.full_name;
      if (isParentAuthor) {
        void sendPushToRole("admin", payload, req.user.id);
      } else {
        const authorId = parent.submitted_by_user_id ?? (await findUserIdByName(parent.submitted_by));
        if (authorId) void sendPushToUser(authorId, payload);
      }
    }
  }),
);

// Проверяет, что сообщение принадлежит текущему пользователю. Основная
// проверка — по author_user_id (надёжно); для старых сообщений, у которых
// он может быть не заполнен (например, после миграции из legacy-приложения),
// падаем обратно на сравнение по ФИО — как и для заявок в остальном файле.
function isOwnComment(comment, user) {
  return comment.author_user_id != null
    ? comment.author_user_id === user.id
    : comment.author === user.full_name;
}

// Редактирование своего сообщения в переписке — как в Телеграме: можно
// поменять текст только своего сообщения, у остальных участников оно
// обновится с пометкой "изменено" (edited_at).
requestsRouter.put(
  "/:id/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });

    const { rows: existingRows } = await pool.query(
      `SELECT id, author, author_user_id FROM request_comments WHERE id = $1 AND request_id = $2`,
      [req.params.commentId, req.params.id],
    );
    const comment = existingRows[0];
    if (!comment) return res.status(404).json({ error: "comment not found" });
    if (!isOwnComment(comment, req.user)) return res.status(403).json({ error: "not allowed" });

    const { rows } = await pool.query(
      `UPDATE request_comments SET text = $1, edited_at = now()
       WHERE id = $2
       RETURNING id, author, author_user_id, text, created_at, edited_at`,
      [String(text).trim(), req.params.commentId],
    );
    res.json(rows[0]);
  }),
);

// Удаление своего сообщения — "удаляется у всех", т.е. жёстко (строка
// стирается из БД), а не помечается как удалённая, в отличие от заявок.
requestsRouter.delete(
  "/:id/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: existingRows } = await pool.query(
      `SELECT id, author, author_user_id FROM request_comments WHERE id = $1 AND request_id = $2`,
      [req.params.commentId, req.params.id],
    );
    const comment = existingRows[0];
    if (!comment) return res.status(404).json({ error: "comment not found" });
    if (!isOwnComment(comment, req.user)) return res.status(403).json({ error: "not allowed" });

    await pool.query(`DELETE FROM request_comments WHERE id = $1`, [req.params.commentId]);
    res.json({ id: comment.id, deleted: true });
  }),
);

// Автор может удалить свою заявку — это "мягкое" удаление: запись остаётся в
// базе со статусом 'deleted', чтобы у остальных участников сохранялась карточка
// и было видно, что заявку удалил именно её автор.
// Admin может удалить ЛЮБУЮ чужую заявку из истории — это уже окончательное
// удаление (запись и переписка по ней стираются насовсем), т.к. для чужой
// заявки пометка "автор удалил" была бы неверной.
requestsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await loadFullRequest(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });

    // Основная проверка — по submitted_by_user_id (надёжно, не зависит от
    // совпадения ФИО у разных сотрудников). Fallback на сравнение по имени —
    // только для случая, когда пользователь-автор с тех пор был удалён
    // (submitted_by_user_id стал NULL через ON DELETE SET NULL) и восстановить
    // однозначную привязку уже нельзя.
    const isOwn = existing.submitted_by_user_id != null
      ? existing.submitted_by_user_id === req.user.id
      : existing.submitted_by === req.user.full_name;
    if (!isOwn && req.user.role !== "admin") {
      return res.status(403).json({ error: "not allowed" });
    }

    if (isOwn) {
      const { rows } = await pool.query(
        `UPDATE requests SET status = 'deleted' WHERE id = $1 RETURNING *`,
        [req.params.id],
      );
      // Мягкое удаление: строка остаётся в БД, поэтому при восстановлении
      // достаточно откатить статус назад — исходная строка никуда не делась.
      await insertAuditLog(pool, {
        entityType: "request",
        entityId: Number(req.params.id),
        action: "delete",
        actorUserId: req.user.id,
        actorName: req.user.full_name,
        before: { ...existing, _hard_deleted: false },
        after: null,
      });
      res.json(rows[0]);
      void sendPushToRole(
        "admin",
        {
          title: "Заявка удалена автором",
          body: existing.text,
          url: `/messages?request=${req.params.id}`,
        },
        req.user.id,
      );
      return;
    }

    await pool.query(`DELETE FROM requests WHERE id = $1`, [req.params.id]);
    // Жёсткое удаление (admin): строка и переписка стёрты насовсем — снимок
    // "до" уже включает комментарии, восстановление пересоберёт всё заново.
    await insertAuditLog(pool, {
      entityType: "request",
      entityId: Number(req.params.id),
      action: "delete",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: { ...existing, _hard_deleted: true },
      after: null,
    });
    res.json({ id: existing.id, deleted: true });
    const authorId = existing.submitted_by_user_id ?? (await findUserIdByName(existing.submitted_by));
    if (authorId) {
      void sendPushToUser(authorId, {
        title: "Ваша заявка удалена администратором",
        body: existing.text,
        url: "/messages",
      });
    }
  }),
);

requestsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required" });
    const { rows } = await pool.query(
      `INSERT INTO requests (text, submitted_by, submitted_by_user_id, status) VALUES ($1,$2,$3,'pending') RETURNING *`,
      [text, req.user.full_name, req.user.id],
    );
    await insertAuditLog(pool, {
      entityType: "request",
      entityId: rows[0].id,
      action: "create",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: null,
      after: { ...rows[0], comments: [] },
    });
    res.status(201).json(rows[0]);

    void sendPushToRole(
      "admin",
      {
        title: `${req.user.full_name}: новая заявка`,
        body: text,
        url: `/messages?request=${rows[0].id}`,
      },
      req.user.id,
    );
  }),
);

// Одобрение/отклонение — только curator/admin.
requestsRouter.put(
  "/:id",
  requireRole("curator", "admin"),
  asyncHandler(async (req, res) => {
    const before = await loadFullRequest(req.params.id);
    if (!before) return res.status(404).json({ error: "not found" });

    const { status, resolved_name, resolved_unit, resolved_price, reject_reason } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE requests SET
         status = COALESCE($1, status),
         resolved_name = COALESCE($2, resolved_name),
         resolved_unit = COALESCE($3, resolved_unit),
         resolved_price = COALESCE($4, resolved_price),
         reject_reason = COALESCE($5, reject_reason),
         resolved_at = CASE WHEN $1 = 'approved' THEN now() ELSE resolved_at END,
         rejected_at = CASE WHEN $1 = 'rejected' THEN now() ELSE rejected_at END,
         resolved_by = CASE WHEN $1 = 'approved' THEN $7 ELSE resolved_by END,
         rejected_by = CASE WHEN $1 = 'rejected' THEN $7 ELSE rejected_by END
       WHERE id = $6 RETURNING *`,
      [
        status,
        resolved_name,
        resolved_unit,
        resolved_price,
        reject_reason,
        req.params.id,
        req.user.full_name,
      ],
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });

    // Одобренная заявка автоматически добавляется в справочник видов работ —
    // upsertWorkTypeByName сам решит, обновить существующий по имени или
    // создать новый (и сам же напишет в audit_log с каскадным пересчётом,
    // если обновляет — см. directories.js).
    if (status === "approved" && resolved_name && resolved_unit && resolved_price != null) {
      await upsertWorkTypeByName({
        name: resolved_name,
        unit: resolved_unit,
        price: resolved_price,
        actorUserId: req.user.id,
        actorName: req.user.full_name,
      });
    }

    await insertAuditLog(pool, {
      entityType: "request",
      entityId: Number(req.params.id),
      action: "update",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before,
      after: { ...rows[0], comments: before.comments },
    });

    res.json(rows[0]);

    const authorId = rows[0].submitted_by_user_id ?? (await findUserIdByName(rows[0].submitted_by));
    if (authorId && (status === "approved" || status === "rejected")) {
      void sendPushToUser(authorId, {
        title: status === "approved" ? "Заявка одобрена" : "Заявка отклонена",
        body: rows[0].text,
        url: `/messages?request=${rows[0].id}`,
      });
    }
  }),
);
