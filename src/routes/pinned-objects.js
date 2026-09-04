import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../async-handler.js";

// Объекты, которые пользователь вручную закрепил у себя на стартовом экране
// "Объекты" — актуально в первую очередь для роли "Кто подал" (user), у которой
// на главном экране иначе показываются только объекты с её собственными записями.
export const pinnedObjectsRouter = Router();

pinnedObjectsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT object_id FROM pinned_objects WHERE user_id = $1`, [
      req.user.id,
    ]);
    res.json(rows.map((r) => r.object_id));
  }),
);

pinnedObjectsRouter.post(
  "/:objectId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query(
      `INSERT INTO pinned_objects (user_id, object_id) VALUES ($1, $2)
       ON CONFLICT (user_id, object_id) DO NOTHING`,
      [req.user.id, req.params.objectId],
    );
    res.status(201).json({ ok: true });
  }),
);

pinnedObjectsRouter.delete(
  "/:objectId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query(`DELETE FROM pinned_objects WHERE user_id = $1 AND object_id = $2`, [
      req.user.id,
      req.params.objectId,
    ]);
    res.json({ ok: true });
  }),
);
