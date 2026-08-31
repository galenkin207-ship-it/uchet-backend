import { Router } from "express";
import { pool } from "../db.js";
import { requireRole, hashPassword } from "../auth.js";

export const usersRouter = Router();

usersRouter.get("/submitters", requireRole("admin", "curator"), async (_req, res) => {
  // Лёгкий эндпоинт (только ФИО, без логинов/паролей) — доступен не только
  // админу, но и куратору, т.к. используется для фильтра "Кто подал" на
  // страницах отчётов, которые куратор тоже видит. Полный список
  // пользователей (GET /) остаётся admin-only.
  const { rows } = await pool.query(
    `SELECT full_name FROM users WHERE is_submitter = true AND active = true ORDER BY full_name`,
  );
  res.json(rows.map((r) => r.full_name));
});

usersRouter.get("/", requireRole("admin"), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login, full_name, role, active, is_submitter, created_at FROM users ORDER BY id`,
  );
  res.json(rows);
});

usersRouter.post("/", requireRole("admin"), async (req, res) => {
  const { login, password, full_name, role = "user", is_submitter = false } = req.body || {};
  if (!login || !password || !full_name) {
    return res.status(400).json({ error: "login, password and full_name are required" });
  }
  // Проверка уникальности ФИО (без учёта регистра и лишних пробелов) — чтобы
  // не завести одного и того же человека дважды под чуть разным написанием.
  const { rows: dupRows } = await pool.query(
    `SELECT id FROM users WHERE lower(btrim(full_name)) = lower(btrim($1))`,
    [full_name],
  );
  if (dupRows.length) {
    return res
      .status(400)
      .json({ error: `Пользователь «${String(full_name).trim()}» уже есть в списке` });
  }
  const password_hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (login, password_hash, full_name, role, active, is_submitter)
     VALUES ($1,$2,$3,$4,true,$5) RETURNING id, login, full_name, role, active, is_submitter`,
    [login, password_hash, full_name, role, is_submitter],
  );
  res.status(201).json(rows[0]);
});

usersRouter.put("/:id", requireRole("admin"), async (req, res) => {
  const { full_name, role, active, password, is_submitter } = req.body || {};
  if (full_name && String(full_name).trim()) {
    const { rows: dupRows } = await pool.query(
      `SELECT id FROM users WHERE lower(btrim(full_name)) = lower(btrim($1)) AND id <> $2`,
      [full_name, req.params.id],
    );
    if (dupRows.length) {
      return res
        .status(400)
        .json({ error: `Пользователь «${String(full_name).trim()}» уже есть в списке` });
    }
  }
  const password_hash = password ? await hashPassword(password) : null;
  const { rows } = await pool.query(
    `UPDATE users SET
       full_name = COALESCE($1, full_name),
       role = COALESCE($2, role),
       active = COALESCE($3, active),
       password_hash = COALESCE($4, password_hash),
       is_submitter = COALESCE($5, is_submitter)
     WHERE id = $6 RETURNING id, login, full_name, role, active, is_submitter`,
    [full_name, role, active, password_hash, is_submitter, req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});
