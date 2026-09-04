import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

export const notificationReadsRouter = Router();

// Верхняя граница на размер пачки — без неё запрос с аномально большим
// массивом ids (баг на фронтенде, кривой скрипт) упирался бы в лимит
// Postgres на число параметров одного запроса (65535) и падал с ошибкой БД
// вместо понятного 400.
const MAX_IDS_PER_REQUEST = 500;

notificationReadsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT item_id FROM notification_reads WHERE user_id = $1`,
      [req.user.id],
    );
    res.json(rows.map((r) => r.item_id));
  } catch (err) {
    console.error("notification-reads GET error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

notificationReadsRouter.post("/", requireAuth, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: true });
    if (ids.length > MAX_IDS_PER_REQUEST) {
      return res.status(400).json({ error: `too many ids, max ${MAX_IDS_PER_REQUEST} per request` });
    }

    const values = ids.map((_, i) => `($1, $${i + 2})`).join(",");
    await pool.query(
      `INSERT INTO notification_reads (user_id, item_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      [req.user.id, ...ids.map(String)],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("notification-reads POST error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
