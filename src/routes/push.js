import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { getVapidPublicKey, isPushEnabled } from "../push-notify.js";

export const pushRouter = Router();

pushRouter.get("/vapid-public-key", (_req, res) => {
  res.json({ enabled: isPushEnabled(), publicKey: getVapidPublicKey() });
});

pushRouter.post("/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "invalid subscription" });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [req.user.id, endpoint, keys.p256dh, keys.auth],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("push subscribe error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

pushRouter.post("/unsubscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [
      endpoint,
      req.user.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("push unsubscribe error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
