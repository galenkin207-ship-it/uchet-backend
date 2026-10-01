import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole, isAdminLike } from "../auth.js";
import { sendPushToRole, sendPushToUser } from "../push-notify.js";
import { insertAuditLog } from "../audit.js";
import { asyncHandler } from "../async-handler.js";
import {
  validatePrice,
  loadLeafParent,
  insertLeaf,
  resolveLeafName,
  buildLeafDetail,
  loadWorkTypePaths,
  scheduleEmbeddingRefresh,
} from "./work-types-shared.js";

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

// Поля ответа на заявку для клиента (мастера и админа):
//   - admin_comment — комментарий админа/куратора: при отклонении — причина
//     (reject_reason), при выполнении — сообщение мастеру (response_message);
//   - work_type — позиция справочника, которой закрыта заявка (work_type_id,
//     миграция 031): название, единица, цена и путь (формат GET
//     /api/work-types/:id/path, но доступно и мастеру — только чтение).
//     available=false — позиция с тех пор архивирована (в запись её добавить
//     нельзя). Если позиция удалена совсем, work_type_id = NULL (ON DELETE SET
//     NULL) и work_type = null.
// paths — Map из loadWorkTypePaths.
function withResponseFields(row, paths) {
  const path = row.work_type_id != null ? paths.get(Number(row.work_type_id)) : null;
  return {
    ...row,
    admin_comment: row.status === "rejected" ? row.reject_reason ?? null : row.response_message ?? null,
    work_type: path
      ? {
          id: path.leaf.id,
          name: path.leaf.name,
          unit: path.unit,
          price: path.price,
          available: path.status !== "archived" && path.level === 5,
          catalog_type: path.catalog_type,
          levels: path.levels,
        }
      : null,
  };
}

async function withResponseFieldsList(rows) {
  const paths = await loadWorkTypePaths(
    pool,
    rows.map((r) => r.work_type_id).filter((id) => id != null),
  );
  return rows.map((r) => withResponseFields(r, paths));
}

// Заявка обработана (выполнена/отклонена) — она больше не требует внимания
// куратора/админа, поэтому связанные с ней уведомления ("новая заявка" +
// вся переписка по ней) сразу помечаются прочитанными для всех, чтобы не
// зависали в списке непрочитанных после того, как решение уже принято.
async function markRequestNotificationsRead(executor, requestId) {
  await executor.query(
    `INSERT INTO notification_reads (user_id, item_id)
     SELECT u.id, item_id
     FROM users u
     CROSS JOIN (
       SELECT $1 || '-new' AS item_id
       UNION ALL
       SELECT id::text FROM request_comments WHERE request_id = $2
     ) items
     ON CONFLICT DO NOTHING`,
    [String(requestId), requestId],
  );
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
    res.json(await withResponseFieldsList(rows));
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
    const { text, record_id } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required" });

    // record_id — запись, из формы которой мастер отправил заявку (необязательно).
    // Нужна только для удобства («Внести в запись» предложит её первой), поэтому
    // чужую/несуществующую запись молча не привязываем, а не отклоняем заявку.
    let recordId = null;
    if (record_id != null && record_id !== "") {
      const rid = Number(record_id);
      if (Number.isInteger(rid)) {
        const { rows: recRows } = await pool.query(
          `SELECT id, created_by_user_id FROM records WHERE id = $1`,
          [rid],
        );
        const rec = recRows[0];
        if (rec && (rec.created_by_user_id === req.user.id || isAdminLike(req.user))) recordId = rec.id;
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO requests (text, submitted_by, submitted_by_user_id, status, record_id)
       VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
      [text, req.user.full_name, req.user.id, recordId],
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

// Максимальная длина сообщения мастеру при одобрении заявки.
const MAX_RESPONSE_MESSAGE_LENGTH = 2000;

// Одобрение/отклонение — только curator/admin.
// Отклонение (status='rejected', необязательный reject_reason — комментарий
// мастеру) — основной путь. Одобрение здесь — только для старых клиентов:
// новый клиент закрывает заявку через POST /:id/complete (с привязкой к
// позиции справочника). Одобрение здесь НЕ создаёт и НЕ изменяет строки
// work_types, а пишет мастеру текст в message → requests.response_message.
// Старые клиенты могут по-прежнему присылать resolved_name/resolved_unit/
// resolved_price — они игнорируются (ни в work_types, ни в заявку не пишутся).
requestsRouter.put(
  "/:id",
  requireRole("curator", "admin"),
  asyncHandler(async (req, res) => {
    const before = await loadFullRequest(req.params.id);
    if (!before) return res.status(404).json({ error: "not found" });

    const { status, reject_reason, message } = req.body || {};

    // message относится только к одобрению; отсутствие поля (или null) —
    // не трогать сохранённое сообщение, пустая строка после trim — очистить.
    let responseMessage;
    if (status === "approved" && message != null) {
      if (typeof message !== "string") {
        return res.status(400).json({ error: "message must be a string" });
      }
      const trimmed = message.trim();
      if (trimmed.length > MAX_RESPONSE_MESSAGE_LENGTH) {
        return res
          .status(400)
          .json({ error: `message must be at most ${MAX_RESPONSE_MESSAGE_LENGTH} characters` });
      }
      responseMessage = trimmed || null;
    }
    const setResponseMessage = responseMessage !== undefined;

    const { rows } = await pool.query(
      `UPDATE requests SET
         status = COALESCE($1, status),
         reject_reason = COALESCE($2, reject_reason),
         response_message = CASE WHEN $4::boolean THEN $5 ELSE response_message END,
         resolved_at = CASE WHEN $1 = 'approved' THEN now() ELSE resolved_at END,
         rejected_at = CASE WHEN $1 = 'rejected' THEN now() ELSE rejected_at END,
         resolved_by = CASE WHEN $1 = 'approved' THEN $6 ELSE resolved_by END,
         rejected_by = CASE WHEN $1 = 'rejected' THEN $6 ELSE rejected_by END
       WHERE id = $3 RETURNING *`,
      [
        status,
        reject_reason,
        req.params.id,
        setResponseMessage,
        responseMessage ?? null,
        req.user.full_name,
      ],
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });

    if (status === "approved" || status === "rejected") {
      await markRequestNotificationsRead(pool, rows[0].id);
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

    res.json((await withResponseFieldsList([rows[0]]))[0]);

    const authorId = rows[0].submitted_by_user_id ?? (await findUserIdByName(rows[0].submitted_by));
    if (authorId && (status === "approved" || status === "rejected")) {
      void sendPushToUser(authorId, {
        title: status === "approved" ? "Заявка одобрена" : "Заявка отклонена",
        body: status === "approved" && rows[0].response_message ? rows[0].response_message : rows[0].text,
        url: `/messages?request=${rows[0].id}`,
      });
    }
  }),
);

// POST /:id/complete — закрыть заявку позицией справочника (curator/admin, как
// и одобрение в PUT /:id). Тело — ЛИБО { work_type_id } (выбор существующей
// позиции), ЛИБО { new_work_type: { parent_id, text, unit, price, has_price,
// labor_hours, gesn_code, work_composition } } — новая позиция по тем же
// правилам, что и строка POST /api/work-types/batch (имя считает сервер:
// под группой text — вариант, иначе полное название). Необязательный comment —
// сообщение мастеру (requests.response_message, до MAX_RESPONSE_MESSAGE_LENGTH).
// Создание позиции, привязка к заявке и смена статуса на approved — одна
// транзакция: при любой ошибке не создаётся ничего. Заявка блокируется FOR
// UPDATE — закрыть её можно только из pending (иначе 409).
requestsRouter.post(
  "/:id/complete",
  requireRole("curator", "admin"),
  asyncHandler(async (req, res) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId)) return res.status(404).json({ error: "not found" });

    const { work_type_id, new_work_type, comment } = req.body || {};

    let responseMessage = null;
    if (comment != null) {
      if (typeof comment !== "string") return res.status(400).json({ error: "comment must be a string" });
      const trimmed = comment.trim();
      if (trimmed.length > MAX_RESPONSE_MESSAGE_LENGTH) {
        return res
          .status(400)
          .json({ error: `comment must be at most ${MAX_RESPONSE_MESSAGE_LENGTH} characters` });
      }
      responseMessage = trimmed || null;
    }

    const hasExisting = work_type_id != null && work_type_id !== "";
    const hasNew = new_work_type != null;
    if (hasExisting === hasNew) {
      return res
        .status(400)
        .json({ error: "Укажите либо позицию из справочника, либо данные новой позиции" });
    }
    if (hasNew && (typeof new_work_type !== "object" || Array.isArray(new_work_type))) {
      return res.status(400).json({ error: "Некорректные данные новой позиции" });
    }

    const before = await loadFullRequest(requestId);
    if (!before) return res.status(404).json({ error: "not found" });

    let createdId = null;
    let updated;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fail = async (status, error) => {
        await client.query("ROLLBACK");
        return res.status(status).json({ error });
      };

      const { rows: lockRows } = await client.query(
        `SELECT status FROM requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!lockRows[0]) return fail(404, "not found");
      if (lockRows[0].status !== "pending") return fail(409, "Заявка уже обработана");

      let workTypeId;
      if (hasExisting) {
        workTypeId = Number(work_type_id);
        if (!Number.isInteger(workTypeId)) return fail(400, "work_type_id должен быть целым числом");
        const { rows: wtRows } = await client.query(
          `SELECT id, level, status FROM work_types WHERE id = $1`,
          [workTypeId],
        );
        const wt = wtRows[0];
        if (!wt) return fail(400, "Позиция не найдена");
        if (wt.level !== 5) return fail(400, "Выберите позицию, а не раздел справочника");
        if (wt.status === "archived") return fail(400, "Позиция в архиве");
      } else {
        const { parent_id, text, unit, price, has_price, labor_hours, gesn_code, work_composition } =
          new_work_type;
        const parentId = Number(parent_id);
        if (parent_id == null || parent_id === "" || !Number.isInteger(parentId)) {
          return fail(400, "Выберите расположение позиции");
        }
        if (unit == null || !String(unit).trim()) return fail(400, "Укажите единицу измерения");
        const priceError = validatePrice(price);
        if (priceError) return fail(400, priceError);

        const { parent, error: parentError } = await loadLeafParent(client, parentId, { forUpdate: true });
        if (parentError) return fail(parentError.status, parentError.error);

        const { name, variantLabel, error: nameError } = resolveLeafName(parent, text);
        if (nameError) return fail(400, nameError);

        const { id, error: insertError } = await insertLeaf(
          client,
          parent,
          { name, variant_label: variantLabel, unit, price, has_price, labor_hours, gesn_code, work_composition },
          { nameConflictMessage: "Такая позиция уже есть в этом месте" },
        );
        if (insertError) return fail(insertError.status, insertError.error);
        createdId = id;
        workTypeId = id;

        await insertAuditLog(client, {
          entityType: "work_type",
          entityId: id,
          action: "create",
          actorUserId: req.user.id,
          actorName: req.user.full_name,
          before: null,
          after: await buildLeafDetail(client, id),
        });
      }

      const { rows } = await client.query(
        `UPDATE requests SET
           status = 'approved',
           work_type_id = $1,
           response_message = $2,
           resolved_at = now(),
           resolved_by = $3
         WHERE id = $4 RETURNING *`,
        [workTypeId, responseMessage, req.user.full_name, requestId],
      );
      updated = rows[0];

      await markRequestNotificationsRead(client, requestId);
      await insertAuditLog(client, {
        entityType: "request",
        entityId: requestId,
        action: "update",
        actorUserId: req.user.id,
        actorName: req.user.full_name,
        before,
        after: { ...updated, comments: before.comments },
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!updated) return; // ответ с ошибкой уже отправлен (fail)

    const [result] = await withResponseFieldsList([updated]);
    res.json(result);
    if (createdId) scheduleEmbeddingRefresh(createdId);

    const authorId = updated.submitted_by_user_id ?? (await findUserIdByName(updated.submitted_by));
    if (authorId) {
      void sendPushToUser(authorId, {
        title: "Заявка выполнена",
        body: result.work_type ? `Позиция: ${result.work_type.name}` : updated.text,
        url: `/messages?request=${updated.id}`,
      });
    }
  }),
);
