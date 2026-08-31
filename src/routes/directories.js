import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

// Небольшой генератор CRUD-роутера для простых справочников вида
// { id, name, ... } — objects, employees, units, work_types.
// Изменять (создавать/править/удалять) могут только curator/admin,
// читать — любой авторизованный пользователь.
function makeDirectoryRouter({
  table,
  columns,
  orderBy = "id",
  extraSelect = [],
  afterUpdate,
  validate,
}) {
  const router = Router();
  const cols = columns.join(", ");
  // extraSelect — колонки, которые нужно только читать (например, служебный
  // статус), но не передавать в INSERT/UPDATE через общий механизм ниже.
  const selectCols = [...columns, ...extraSelect].join(", ");

  router.get("/", requireAuth, async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, ${selectCols} FROM ${table} ORDER BY ${orderBy}`);
    res.json(rows);
  });

  router.post("/", requireRole("curator", "admin"), async (req, res) => {
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
    res.status(201).json(rows[0]);
  });

  router.put("/:id", requireRole("curator", "admin"), async (req, res) => {
    if (validate) {
      const error = await validate(pool, req.body, req.params.id);
      if (error) return res.status(400).json({ error });
    }
    const set = columns.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const values = [...columns.map((c) => req.body[c]), req.params.id];

    // Простые справочники (объекты, сотрудники, единицы) без каскадных
    // побочных эффектов обновляем как раньше, одним запросом без транзакции.
    if (!afterUpdate) {
      const { rows } = await pool.query(
        `UPDATE ${table} SET ${set} WHERE id = $${columns.length + 1} RETURNING id, ${cols}`,
        values,
      );
      if (!rows[0]) return res.status(404).json({ error: "not found" });
      return res.json(rows[0]);
    }

    // Справочники, изменения в которых должны каскадно пересчитать уже
    // существующие данные (например, виды работ → позиции записей →
    // суммы записей) — всё в одной транзакции, чтобы не оставить БД в
    // промежуточном состоянии при сбое на середине каскада.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE ${table} SET ${set} WHERE id = $${columns.length + 1} RETURNING id, ${cols}`,
        values,
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "not found" });
      }
      await afterUpdate(client, rows[0]);
      await client.query("COMMIT");
      res.json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  router.delete("/:id", requireRole("admin"), async (req, res) => {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    res.json({ deleted: Number(req.params.id) });
  });

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
});

// Завершение объекта: данные (записи, заявки, комментарии) никуда не деваются,
// объект просто перестаёт показываться в основном списке и переходит в Историю.
objectsRouter.patch("/:id/archive", requireRole("curator", "admin"), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE objects SET status = 'archived', archived_at = now()
     WHERE id = $1
     RETURNING id, name, address, progress_percent, status, archived_at`,
    [req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// Возврат объекта из Истории обратно в активную работу.
objectsRouter.patch("/:id/restore", requireRole("curator", "admin"), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE objects SET status = 'active', archived_at = NULL
     WHERE id = $1
     RETURNING id, name, address, progress_percent, status, archived_at`,
    [req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

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
});

export const unitsRouter = makeDirectoryRouter({
  table: "units",
  columns: ["name"],
});

export const workTypesRouter = makeDirectoryRouter({
  table: "work_types",
  columns: ["name", "unit", "price"],
  afterUpdate: async (client, updated) => {
    // Каскадный пересчёт: название/единица/цена вида работы всегда должны
    // совпадать с тем, что показано во всех записях, где он использован —
    // в т.ч. уже завершённых (done). Прежние значения нигде не сохраняются
    // (по явному решению — история изменений цен не нужна).
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
  },
});
