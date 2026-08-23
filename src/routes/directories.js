import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

// Небольшой генератор CRUD-роутера для простых справочников вида
// { id, name, ... } — objects, employees, units, work_types.
// Изменять (создавать/править/удалять) могут только curator/admin,
// читать — любой авторизованный пользователь.
function makeDirectoryRouter({ table, columns, orderBy = "id", extraSelect = [] }) {
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
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${set} WHERE id = $${columns.length + 1} RETURNING id, ${cols}`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
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
});
