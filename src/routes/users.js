import { Router } from "express";
import { pool } from "../db.js";
import { requireRole, hashPassword } from "../auth.js";

export const usersRouter = Router();

usersRouter.get("/", requireRole("admin"), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login, full_name, role, active, created_at FROM users ORDER BY id`,
  );
  res.json(rows);
});

usersRouter.post("/", requireRole("admin"), async (req, res) => {
  const { login, password, full_name, role = "user" } = req.body || {};
  if (!login || !password || !full_name) {
    return res.status(400).json({ error: "login, password and full_name are required" });
  }
  const password_hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (login, password_hash, full_name, role, active)
     VALUES ($1,$2,$3,$4,true) RETURNING id, login, full_name, role, active`,
    [login, password_hash, full_name, role],
  );
  res.status(201).json(rows[0]);
});

usersRouter.put("/:id", requireRole("admin"), async (req, res) => {
  const { full_name, role, active, password } = req.body || {};
  const password_hash = password ? await hashPassword(password) : null;
  const { rows } = await pool.query(
    `UPDATE users SET
       full_name = COALESCE($1, full_name),
       role = COALESCE($2, role),
       active = COALESCE($3, active),
       password_hash = COALESCE($4, password_hash)
     WHERE id = $5 RETURNING id, login, full_name, role, active`,
    [full_name, role, active, password_hash, req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});
