import { Router } from "express";
import { pool } from "../db.js";
import { setSessionCookie, clearSessionCookie, verifyPassword } from "../auth.js";
import { asyncHandler } from "../async-handler.js";

export const authRouter = Router();

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
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  res.json(req.user);
});
