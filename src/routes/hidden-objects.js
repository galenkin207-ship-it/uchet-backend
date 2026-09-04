import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../async-handler.js";

// Объекты, которые пользователь вручную скрыл со своего главного экрана
// "Объекты" — в отличие от pinned_objects (принудительный показ), это
// принудительное скрытие: работает даже для объектов, у которых уже есть
// записи, и не влияет на других пользователей и на сам объект (он не
// архивируется и остаётся доступен в "Управление -> Объекты").
export const hiddenObjectsRouter = Router();

hiddenObjectsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT object_id FROM hidden_objects WHERE user_id = $1`, [
      req.user.id,
    ]);
    res.json(rows.map((r) => r.object_id));
  }),
);

hiddenObjectsRouter.post(
  "/:objectId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query(
      `INSERT INTO hidden_objects (user_id, object_id) VALUES ($1, $2)
       ON CONFLICT (user_id, object_id) DO NOTHING`,
      [req.user.id, req.params.objectId],
    );
    res.status(201).json({ ok: true });
  }),
);

hiddenObjectsRouter.delete(
  "/:objectId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query(`DELETE FROM hidden_objects WHERE user_id = $1 AND object_id = $2`, [
      req.user.id,
      req.params.objectId,
    ]);
    res.json({ ok: true });
  }),
);
