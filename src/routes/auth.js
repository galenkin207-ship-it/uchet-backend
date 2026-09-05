import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { setSessionCookie, clearSessionCookie, verifyPassword, hashPassword } from "../auth.js";
import { asyncHandler } from "../async-handler.js";
import { sendMail } from "../mailer.js";

export const authRouter = Router();

const RESET_TOKEN_TTL = "1 hour";
const RESET_COOLDOWN = "5 minutes"; // не чаще одного письма за этот период на пользователя

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ error: "login and password are required" });
    }
    const { rows } = await pool.query(
      "SELECT id, login, password_hash, full_name, role, active FROM users WHERE login = $1",
      [login.trim()],
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    setSessionCookie(res, user.id);
    res.json({ id: user.id, login: user.login, full_name: user.full_name, role: user.role });
  }),
);

authRouter.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  // См. attachUser в auth.js: dbUnavailable значит "БД на секунду недоступна",
  // а не "сессия невалидна" — это должно быть 503, а не 401, иначе фронтенд
  // разлогинивает пользователя с рабочей сессией из-за временного сбоя БД
  // (типично сразу после рестарта бэкенда при деплое).
  if (req.dbUnavailable) return res.status(503).json({ error: "db_unavailable" });
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  res.json(req.user);
});

// Всегда один и тот же ответ, есть такой email в базе или нет — иначе сам
// факт разного ответа позволял бы перебором проверять, чей email
// зарегистрирован в системе.
const FORGOT_PASSWORD_RESPONSE = {
  ok: true,
  message: "Если такой email зарегистрирован, на него отправлено письмо",
};

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.json(FORGOT_PASSWORD_RESPONSE);
    }

    const { rows: users } = await pool.query(
      `SELECT id, login, full_name FROM users WHERE lower(email) = lower($1) AND active = true`,
      [email.trim()],
    );
    if (!users.length) return res.json(FORGOT_PASSWORD_RESPONSE);

    // Троттлинг по пользователю, а не по email — иначе тот, кто знает чужой
    // email, мог бы завалить его письмами, посылая запросы под разными
    // логинами, если бы вдруг у нескольких аккаунтов совпал email.
    const userIds = users.map((u) => u.id);
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM password_reset_tokens
       WHERE user_id = ANY($1) AND created_at > now() - interval '${RESET_COOLDOWN}'
       LIMIT 1`,
      [userIds],
    );
    if (recent.length) return res.json(FORGOT_PASSWORD_RESPONSE);

    // Один email в редких случаях может стоять у нескольких логинов (например,
    // у мастера основной аккаунт и тестовый) — присылаем один список со всеми
    // сразу, чтобы не пришлось запрашивать восстановление несколько раз.
    const appUrl = (process.env.APP_URL || "https://uchet.kostya.online").replace(/\/$/, "");
    const lines = [];
    for (const user of users) {
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '${RESET_TOKEN_TTL}')`,
        [user.id, hashToken(token)],
      );
      lines.push(`Логин «${user.login}» (${user.full_name}): ${appUrl}/reset-password?token=${token}`);
    }

    const sent = await sendMail({
      to: email.trim(),
      subject: "Восстановление доступа — Учёт работ",
      text:
        `Запрошено восстановление доступа к «Учёт работ».\n\n` +
        `${lines.join("\n")}\n\n` +
        `Ссылка действует 1 час и работает один раз.\n` +
        `Если вы не запрашивали восстановление — просто игнорируйте это письмо, пароль не изменится.`,
    });
    if (!sent) {
      console.error(`forgot-password: не удалось отправить письмо на ${email} (SMTP недоступен?)`);
    }

    res.json(FORGOT_PASSWORD_RESPONSE);
  }),
);

authRouter.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "ссылка недействительна" });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "пароль должен быть не короче 6 символов" });
    }

    const { rows } = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!rows.length) {
      return res.status(400).json({ error: "ссылка недействительна или уже использована — запросите новую" });
    }

    const { user_id } = rows[0];
    const password_hash = await hashPassword(password);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [password_hash, user_id]);
    // Гасим все неиспользованные токены этого пользователя разом (не только
    // текущий) — если было запрошено несколько писем подряд, старые ссылки
    // не должны оставаться рабочими после того, как пароль уже сменили.
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [user_id],
    );

    res.json({ ok: true });
  }),
);
