import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../async-handler.js";

// Бригады — личный справочник каждого пользователя, нужен только для
// быстрого заполнения состава записи (см. record-form на фронтенде).
// Видны и редактируются только тем, кто их создал; на сохранённые записи
// (records.employees) не влияют — там всегда обычный список сотрудников.
export const brigadesRouter = Router();

brigadesRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, members FROM brigades WHERE user_id = $1 ORDER BY name`,
      [req.user.id],
    );
    res.json(rows);
  }),
);

brigadesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, members = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    const { rows } = await pool.query(
      `INSERT INTO brigades (user_id, name, members) VALUES ($1,$2,$3) RETURNING id, name, members`,
      [req.user.id, String(name).trim(), members],
    );
    res.status(201).json(rows[0]);
  }),
);

brigadesRouter.put(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, members = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    const { rows } = await pool.query(
      `UPDATE brigades SET name = $1, members = $2 WHERE id = $3 AND user_id = $4
       RETURNING id, name, members`,
      [String(name).trim(), members, req.params.id, req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  }),
);

brigadesRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM brigades WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json({ deleted: Number(req.params.id) });
  }),
);
