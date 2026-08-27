import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

// Небольшой генератор CRUD-роутера для простых справочников вида
// { id, name, ... } — objects, employees, units, work_types.
// Изменять (создавать/править/удалять) могут только curator/admin,
// читать — любой авторизованный пользователь.
function makeDirectoryRouter({ table, columns, orderBy = "id", extraSelect = [], afterUpdate }) {
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
    const values = columns.map((c) => req.body[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await pool.query(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING id, ${cols}`,
      values,
    );
    res.status(201).json(rows[0]);
  });

  router.put("/:id", requireRole("curator", "admin"), async (req, res) => {
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

export const employeesRouter = makeDirectoryRouter({
  table: "employees",
  columns: ["name"],
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
