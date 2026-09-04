import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { pool } from "./db.js";

// Падаем сразу и громко на старте, если секрет не задан, вместо того чтобы
// молча дожить до первого логина/запроса с cookie и упасть там (см. .env.example).
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET не задан в .env — без него нельзя подписывать сессии. См. .env.example.",
  );
}

const COOKIE_NAME = "uchet_session";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 год, как в старом приложении

function sign(userId) {
  const payload = `${userId}.${Date.now() + MAX_AGE_MS}`;
  const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

function verify(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, hmac] = parts;
  const payload = `${userId}.${expiresAt}`;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const hmacBuf = Buffer.from(hmac);
  const expectedBuf = Buffer.from(expected);
  // crypto.timingSafeEqual требует буферы одинаковой длины и иначе бросает
  // RangeError — а hmac полностью подконтролен клиенту через cookie. Раньше
  // подделанная/битая cookie с hmac другой длины валила verify() необработанным
  // исключением ещё до try/catch в attachUser, и запрос зависал без ответа.
  if (hmacBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(hmacBuf, expectedBuf)) return null;
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
  let userId = null;
  try {
    userId = verify(req.cookies?.[COOKIE_NAME]);
  } catch (err) {
    // Доп. подстраховка: даже если в verify() когда-нибудь снова попадёт
    // непредвиденный throw, запрос не должен зависать без ответа.
    console.error("attachUser verify error:", err);
    userId = null;
  }
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
