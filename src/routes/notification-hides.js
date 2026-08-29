import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

export const notificationHidesRouter = Router();

notificationHidesRouter.get("/", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT item_id FROM notification_hides WHERE user_id = $1`,
      [req.user.id],
    );
    res.json(rows.map((r) => r.item_id));
  } catch (err) {
    console.error("notification-hides GET error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

notificationHidesRouter.post("/", requireAuth, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: true });

    const values = ids.map((_, i) => `($1, $${i + 2})`).join(",");
    await pool.query(
      `INSERT INTO notification_hides (user_id, item_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      [req.user.id, ...ids.map(String)],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("notification-hides POST error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
