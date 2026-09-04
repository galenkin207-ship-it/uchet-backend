import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { insertAuditLog } from "../audit.js";
import { asyncHandler } from "../async-handler.js";

// Небольшой генератор CRUD-роутера для простых справочников вида
// { id, name, ... } — objects, employees, units, work_types.
// Изменять (создавать/править/удалять) может только admin — куратор в
// управлении справочниками не участвует (единственный интерфейс для этого,
// раздел "Управление", доступен только администратору; отдельно от этого
// куратор по-прежнему может архивировать/восстанавливать объект — см.
// objectsRouter.patch("/:id/archive"/"/restore") ниже, у них своя проверка роли).
// Читать справочники — любой авторизованный пользователь.
//
// entityType — если указан, каждое create/update/delete пишет запись в
// audit_log (см. src/audit.js). До этой правки справочники были единственным
// местом в приложении без истории изменений — притом что именно здесь
// (work_types.afterUpdate) правки могут ретроактивно менять суммы уже
// завершённых записей, и раньше это происходило вообще без следа в аудите.
function makeDirectoryRouter({
  table,
  columns,
  orderBy = "id",
  extraSelect = [],
  afterUpdate,
  validate,
  entityType,
}) {
  const router = Router();
  const cols = columns.join(", ");
  // extraSelect — колонки, которые нужно только читать (например, служебный
  // статус), но не передавать в INSERT/UPDATE через общий механизм ниже.
  const selectCols = [...columns, ...extraSelect].join(", ");

  router.get(
    "/",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const { rows } = await pool.query(`SELECT id, ${selectCols} FROM ${table} ORDER BY ${orderBy}`);
      res.json(rows);
    }),
  );

  router.post(
    "/",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      // validate — необязательная проверка перед записью (например, уникальность
      // по имени без учёта регистра/пробелов). Возвращает текст ошибки или null.
      if (validate) {
        const error = await validate(pool, req.body, null);
        if (error) return res.status(400).json({ error });
      }
      const values = columns.map((c) => req.body[c]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await pool.query(
        `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING id, ${cols}`,
        values,
      );
      if (entityType) {
        await insertAuditLog(pool, {
          entityType,
          entityId: rows[0].id,
          action: "create",
          actorUserId: req.user.id,
          actorName: req.user.full_name,
          before: null,
          after: rows[0],
        });
      }
      res.status(201).json(rows[0]);
    }),
  );

  router.put(
    "/:id",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      if (validate) {
        const error = await validate(pool, req.body, req.params.id);
        if (error) return res.status(400).json({ error });
      }
      const set = columns.map((c, i) => `${c} = $${i + 1}`).join(", ");
      const values = [...columns.map((c) => req.body[c]), req.params.id];

      // Простые справочники (объекты, сотрудники, единицы) без каскадных
      // побочных эффектов обновляем как раньше, одним запросом без транзакции.
      if (!afterUpdate) {
        const { rows: beforeRows } = await pool.query(
          `SELECT id, ${cols} FROM ${table} WHERE id = $1`,
          [req.params.id],
        );
        if (!beforeRows[0]) return res.status(404).json({ error: "not found" });

        const { rows } = await pool.query(
          `UPDATE ${table} SET ${set} WHERE id = $${columns.length + 1} RETURNING id, ${cols}`,
          values,
        );
        if (entityType) {
          await insertAuditLog(pool, {
            entityType,
            entityId: rows[0].id,
            action: "update",
            actorUserId: req.user.id,
            actorName: req.user.full_name,
            before: beforeRows[0],
            after: rows[0],
          });
        }
        return res.json(rows[0]);
      }

      // Справочники, изменения в которых должны каскадно пересчитать уже
      // существующие данные (например, виды работ → позиции записей →
      // суммы записей) — всё в одной транзакции, чтобы не оставить БД в
      // промежуточном состоянии при сбое на середине каскада. Запись в
      // audit_log — в той же транзакции, чтобы не могло получиться так,
      // что цена в справочнике и суммы в записях поменялись, а след в
      // аудите — нет (или наоборот).
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: beforeRows } = await client.query(
          `SELECT id, ${cols} FROM ${table} WHERE id = $1`,
          [req.params.id],
        );
        if (!beforeRows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "not found" });
        }
        const { rows } = await client.query(
          `UPDATE ${table} SET ${set} WHERE id = $${columns.length + 1} RETURNING id, ${cols}`,
          values,
        );
        await afterUpdate(client, rows[0]);
        if (entityType) {
          await insertAuditLog(client, {
            entityType,
            entityId: rows[0].id,
            action: "update",
            actorUserId: req.user.id,
            actorName: req.user.full_name,
            before: beforeRows[0],
            after: rows[0],
          });
        }
        await client.query("COMMIT");
        res.json(rows[0]);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  router.delete(
    "/:id",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      // RETURNING позволяет одновременно (а) узнать, существовала ли строка
      // вообще — раньше DELETE отвечал "успех" даже для несуществующего id —
      // и (б) взять снимок "до" для audit_log без отдельного SELECT.
      const { rows } = await pool.query(
        `DELETE FROM ${table} WHERE id = $1 RETURNING id, ${cols}`,
        [req.params.id],
      );
      if (!rows[0]) return res.status(404).json({ error: "not found" });
      if (entityType) {
        await insertAuditLog(pool, {
          entityType,
          entityId: rows[0].id,
          action: "delete",
          actorUserId: req.user.id,
          actorName: req.user.full_name,
          before: rows[0],
          after: null,
        });
      }
      res.json({ deleted: rows[0].id });
    }),
  );

  return router;
}

export const objectsRouter = makeDirectoryRouter({
  table: "objects",
  columns: ["name", "address", "progress_percent"],
  extraSelect: ["status", "archived_at"],
  // Объекты — как и сотрудники — всегда по алфавиту, а не по порядку
  // добавления: так новый объект сразу встаёт на своё место в списках и
  // фильтрах, а не в конец.
  orderBy: "lower(name)",
  entityType: "object",
});

// Завершение объекта: данные (записи, заявки, комментарии) никуда не деваются,
// объект просто перестаёт показываться в основном списке и переходит в Историю.
objectsRouter.patch(
  "/:id/archive",
  requireRole("curator", "admin"),
  asyncHandler(async (req, res) => {
    const { rows: beforeRows } = await pool.query(
      `SELECT id, name, address, progress_percent, status, archived_at FROM objects WHERE id = $1`,
      [req.params.id],
    );
    if (!beforeRows[0]) return res.status(404).json({ error: "not found" });

    const { rows } = await pool.query(
      `UPDATE objects SET status = 'archived', archived_at = now()
       WHERE id = $1
       RETURNING id, name, address, progress_percent, status, archived_at`,
      [req.params.id],
    );
    await insertAuditLog(pool, {
      entityType: "object",
      entityId: rows[0].id,
      action: "update",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: beforeRows[0],
      after: rows[0],
    });
    res.json(rows[0]);
  }),
);

// Возврат объекта из Истории обратно в активную работу.
objectsRouter.patch(
  "/:id/restore",
  requireRole("curator", "admin"),
  asyncHandler(async (req, res) => {
    const { rows: beforeRows } = await pool.query(
      `SELECT id, name, address, progress_percent, status, archived_at FROM objects WHERE id = $1`,
      [req.params.id],
    );
    if (!beforeRows[0]) return res.status(404).json({ error: "not found" });

    const { rows } = await pool.query(
      `UPDATE objects SET status = 'active', archived_at = NULL
       WHERE id = $1
       RETURNING id, name, address, progress_percent, status, archived_at`,
      [req.params.id],
    );
    await insertAuditLog(pool, {
      entityType: "object",
      entityId: rows[0].id,
      action: "update",
      actorUserId: req.user.id,
      actorName: req.user.full_name,
      before: beforeRows[0],
      after: rows[0],
    });
    res.json(rows[0]);
  }),
);

// Сотрудники всегда показываются в алфавитном порядке по ФИО (а не по
// порядку добавления, как остальные справочники по умолчанию) — так проще
// находить нужного человека в длинном списке, и новые сотрудники сразу
// встают на своё место в списке, а не в конец.
//
// Проверка уникальности ФИО (без учёта регистра и лишних пробелов), чтобы
// одного и того же сотрудника случайно не завели в справочник дважды под
// чуть разным написанием пробелов/регистра.
async function checkNameUnique(pool, table, name, excludeId, kindLabel) {
  if (!name || !String(name).trim()) return null;
  const { rows } = await pool.query(
    excludeId
      ? `SELECT id FROM ${table} WHERE lower(btrim(name)) = lower(btrim($1)) AND id <> $2`
      : `SELECT id FROM ${table} WHERE lower(btrim(name)) = lower(btrim($1))`,
    excludeId ? [name, excludeId] : [name],
  );
  if (rows.length) {
    return `${kindLabel} «${String(name).trim()}» уже есть в справочнике`;
  }
  return null;
}

export const employeesRouter = makeDirectoryRouter({
  table: "employees",
  columns: ["name"],
  orderBy: "lower(name)",
  validate: (pool, body, excludeId) =>
    checkNameUnique(pool, "employees", body.name, excludeId, "Сотрудник"),
  entityType: "employee",
});

export const unitsRouter = makeDirectoryRouter({
  table: "units",
  columns: ["name"],
  entityType: "unit",
});

// Каскадный пересчёт: название/единица/цена вида работы всегда должны
// совпадать с тем, что показано во всех записях, где он использован —
// в т.ч. уже завершённых (done). Прежние значения нигде не сохраняются
// (по явному решению — история изменений цен не нужна), но сам факт
// изменения остаётся в audit_log.
//
// Вынесено в отдельную функцию, чтобы использовать её из двух мест:
// обновление через справочник (см. workTypesRouter ниже) и авто-обновление
// при одобрении заявки (см. upsertWorkTypeByName и requests.js) — раньше
// эти два пути были рассинхронизированы: одобрение заявки писало цену
// напрямую в work_types в обход и каскада, и audit_log.
async function cascadeWorkTypeUpdate(client, updated) {
  await client.query(
    `UPDATE record_items
        SET name = $1, unit = $2, price = $3, sum = qty * $3
      WHERE work_type_id = $4`,
    [updated.name, updated.unit, updated.price, updated.id],
  );
  await client.query(
    `UPDATE records r
        SET total = sub.total
       FROM (
         SELECT record_id, COALESCE(SUM(sum), 0) AS total
         FROM record_items
         WHERE record_id IN (SELECT DISTINCT record_id FROM record_items WHERE work_type_id = $1)
         GROUP BY record_id
       ) sub
      WHERE r.id = sub.record_id`,
    [updated.id],
  );
}

function validatePrice(price) {
  if (price == null) return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return "Цена должна быть неотрицательным числом";
  return null;
}

export const workTypesRouter = makeDirectoryRouter({
  table: "work_types",
  columns: ["name", "unit", "price"],
  entityType: "work_type",
  afterUpdate: cascadeWorkTypeUpdate,
  validate: (_pool, body) => validatePrice(body.price),
});

// Одобрение заявки раньше всегда безусловно вставляло новую строку в
// work_types, даже если вид работы с таким названием уже существовал —
// из-за этого в справочнике накапливались дубли с одинаковым названием и
// разными ценами (обнаружено на практике: два одноимённых вида работы с
// разными ценами на staging). Теперь сначала ищем существующий по имени
// (без учёта регистра/пробелов, как и везде в справочниках) и обновляем
// его — с тем же каскадом и той же audit-записью, что и ручное редактирование
// через справочник — вместо создания дубля.
export async function upsertWorkTypeByName({ name, unit, price, actorUserId, actorName }) {
  const trimmedName = String(name).trim();
  const { rows: existingRows } = await pool.query(
    `SELECT id, name, unit, price FROM work_types WHERE lower(btrim(name)) = lower(btrim($1))`,
    [trimmedName],
  );

  if (existingRows[0]) {
    const before = existingRows[0];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE work_types SET unit = $1, price = $2 WHERE id = $3 RETURNING id, name, unit, price`,
        [unit, price, before.id],
      );
      await cascadeWorkTypeUpdate(client, rows[0]);
      await insertAuditLog(client, {
        entityType: "work_type",
        entityId: rows[0].id,
        action: "update",
        actorUserId,
        actorName,
        before,
        after: rows[0],
      });
      await client.query("COMMIT");
      return rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO work_types (name, unit, price) VALUES ($1,$2,$3) RETURNING id, name, unit, price`,
    [trimmedName, unit, price],
  );
  await insertAuditLog(pool, {
    entityType: "work_type",
    entityId: rows[0].id,
    action: "create",
    actorUserId,
    actorName,
    before: null,
    after: rows[0],
  });
  return rows[0];
}
