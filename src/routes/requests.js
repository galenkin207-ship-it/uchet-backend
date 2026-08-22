import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const requestsRouter = Router();

requestsRouter.get("/", requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT r.*,
      COALESCE(
        json_agg(
          json_build_object('id', c.id, 'author', c.author, 'text', c.text, 'created_at', c.created_at)
          ORDER BY c.created_at
        ) FILTER (WHERE c.id IS NOT NULL),
        '[]'
      ) AS comments
    FROM requests r
    LEFT JOIN request_comments c ON c.request_id = r.id
    GROUP BY r.id
    ORDER BY r.id DESC
  `);
  res.json(rows);
});

requestsRouter.post("/:id/comments", requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });

  const { rows: reqRows } = await pool.query(`SELECT id FROM requests WHERE id = $1`, [
    req.params.id,
  ]);
  if (!reqRows[0]) return res.status(404).json({ error: "request not found" });

  const { rows } = await pool.query(
    `INSERT INTO request_comments (request_id, author, author_user_id, text)
     VALUES ($1,$2,$3,$4) RETURNING id, author, text, created_at`,
    [req.params.id, req.user.full_name, req.user.id, String(text).trim()],
  );
  res.status(201).json(rows[0]);
});

requestsRouter.post("/", requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text is required" });
  const { rows } = await pool.query(
    `INSERT INTO requests (text, submitted_by, status) VALUES ($1,$2,'pending') RETURNING *`,
    [text, req.user.full_name],
  );
  res.status(201).json(rows[0]);
});

// Одобрение/отклонение — только curator/admin.
requestsRouter.put("/:id", requireRole("curator", "admin"), async (req, res) => {
  const { status, resolved_name, resolved_unit, resolved_price, reject_reason } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE requests SET
       status = COALESCE($1, status),
       resolved_name = COALESCE($2, resolved_name),
       resolved_unit = COALESCE($3, resolved_unit),
       resolved_price = COALESCE($4, resolved_price),
       reject_reason = COALESCE($5, reject_reason),
       resolved_at = CASE WHEN $1 = 'approved' THEN now() ELSE resolved_at END,
       rejected_at = CASE WHEN $1 = 'rejected' THEN now() ELSE rejected_at END
     WHERE id = $6 RETURNING *`,
    [status, resolved_name, resolved_unit, resolved_price, reject_reason, req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });

  // Одобренная заявка автоматически добавляется в справочник видов работ.
  if (status === "approved" && resolved_name && resolved_unit && resolved_price != null) {
    await pool.query(
      `INSERT INTO work_types (name, unit, price) VALUES ($1,$2,$3)`,
      [resolved_name, resolved_unit, resolved_price],
    );
  }

  res.json(rows[0]);
});
