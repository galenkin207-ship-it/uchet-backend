import webpush from "web-push";
import { pool } from "./db.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const enabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (enabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn(
    "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY не заданы в .env — push-уведомления отключены.",
  );
}

export function isPushEnabled() {
  return enabled;
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

/** Отправляет push конкретному пользователю по всем его подпискам (может быть несколько устройств). */
export async function sendPushToUser(userId, payload) {
  if (!enabled) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    );
    await Promise.all(rows.map((row) => sendToSubscription(row, payload)));
  } catch (err) {
    console.error("sendPushToUser error:", err);
  }
}

/** Отправляет push всем пользователям с указанной ролью (кроме excludeUserId, если задан). */
export async function sendPushToRole(role, payload, excludeUserId) {
  if (!enabled) return;
  try {
    const { rows } = await pool.query(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN users u ON u.id = ps.user_id
       WHERE u.role = $1 AND ($2::int IS NULL OR u.id <> $2)`,
      [role, excludeUserId ?? null],
    );
    await Promise.all(rows.map((row) => sendToSubscription(row, payload)));
  } catch (err) {
    console.error("sendPushToRole error:", err);
  }
}

async function sendToSubscription(row, payload) {
  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    // 404/410 — подписка больше не действительна (пользователь отписался/сменил браузер) — чистим её.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]).catch(() => {});
    } else {
      console.error("web-push send error:", err.statusCode, err.body || err.message);
    }
  }
}
