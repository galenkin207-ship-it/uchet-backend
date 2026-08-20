import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { pool } from "./db.js";

const COOKIE_NAME = "uchet_session";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 год, как в старом приложении

function sign(userId) {
  const secret = process.env.SESSION_SECRET;
  const payload = `${userId}.${Date.now() + MAX_AGE_MS}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

function verify(token) {
  if (!token) return null;
  const secret = process.env.SESSION_SECRET;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, hmac] = parts;
  const payload = `${userId}.${expiresAt}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
  if (Date.now() > Number(expiresAt)) return null;
  return Number(userId);
}

export function setSessionCookie(res, userId) {
  res.cookie(COOKIE_NAME, sign(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// Middleware: подкладывает req.user, если сессия валидна. Не требует авторизации сам по себе.
export async function attachUser(req, _res, next) {
  const userId = verify(req.cookies?.[COOKIE_NAME]);
  if (!userId) {
    req.user = null;
    return next();
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, login, full_name, role, active FROM users WHERE id = $1",
      [userId],
    );
    req.user = rows[0] && rows[0].active ? rows[0] : null;
  } catch (err) {
    console.error("attachUser db error:", err);
    req.user = null;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}
