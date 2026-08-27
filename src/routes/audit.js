import { Router } from "express";
import { pool } from "../db.js";
import { requireRole } from "../auth.js";
import { insertAuditLog } from "../audit.js";
import { loadFullRecord, restorePhotosFromTrash } from "./records.js";
import { loadFullRequest } from "./requests.js";

export const auditRouter = Router();

// Историю смотрят curator и admin, восстанавливать может только admin
// (это операция, которая может перезаписать текущее состояние записи/заявки).
auditRouter.get("/", requireRole("curator", "admin"), async (req, res) => {
  const { entity_type, entity_id, actor, from, to, limit = 50, offset = 0 } = req.query;
  const clauses = [];
  const params = [];

  if (entity_type) {
    params.push(entity_type);
    clauses.push(`entity_type = $${params.length}`);
  }
  if (entity_id) {
    params.push(Number(entity_id));
    clauses.push(`entity_id = $${params.length}`);
  }
  if (actor) {
    params.push(`%${actor}%`);
    clauses.push(`actor_name ILIKE $${params.length}`);
  }
  if (from) {
    params.push(from);
    clauses.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`created_at <= $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log ${where}`, params);
  const total = Number(countRows[0].count);

  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const off = Math.max(0, Number(offset) || 0);
  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT id, entity_type, entity_id, action, actor_user_id, actor_name,
            (before_data IS NOT NULL) AS has_before, (after_data IS NOT NULL) AS has_after,
            restored_at, restored_by_name, created_at
     FROM audit_log ${where}
     ORDER BY id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ entries: rows, total, offset: off, has_more: off + rows.length < total });
});

auditRouter.get("/:id", requireRole("curator", "admin"), async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM audit_log WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

auditRouter.post("/:id/restore", requireRole("admin"), async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM audit_log WHERE id = $1`, [req.params.id]);
  const entry = rows[0];
  if (!entry) return res.status(404).json({ error: "not found" });
  if (!entry.before_data) {
    return res.status(400).json({ error: "nothing to restore for this entry" });
  }
  if (entry.action !== "update" && entry.action !== "delete") {
    return res.status(400).json({ error: "only update/delete entries can be restored" });
  }

  try {
    if (entry.entity_type === "record") {
      await restoreRecord(entry.entity_id, entry.before_data);
    } else if (entry.entity_type === "request") {
      await restoreRequest(entry.entity_id, entry.before_data);
    } else {
      return res.status(400).json({ error: "unknown entity_type" });
    }
  } catch (err) {
    console.error("restore failed:", err);
    return res.status(500).json({ error: "restore failed" });
  }

  await pool.query(
    `UPDATE audit_log SET restored_at = now(), restored_by_user_id = $1, restored_by_name = $2 WHERE id = $3`,
    [req.user.id, req.user.full_name, req.params.id],
  );

  const restoredAfter =
    entry.entity_type === "record"
      ? await loadFullRecord(entry.entity_id)
      : await loadFullRequest(entry.entity_id);

  await insertAuditLog(pool, {
    entityType: entry.entity_type,
    entityId: entry.entity_id,
    action: "restore",
    actorUserId: req.user.id,
    actorName: req.user.full_name,
    before: null,
    after: restoredAfter,
  });

  res.json({ restored: true, entity: restoredAfter });
});

async function restoreRecord(id, snapshot) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: exists } = await client.query(`SELECT id FROM records WHERE id = $1`, [id]);

    if (exists[0]) {
      // Запись ещё существует (снимок был от правки) — откатываем поля назад.
      await client.query(
        `UPDATE records SET object_id=$1, object_name_raw=$2, employees=$3, date=$4, total=$5,
           comment=$6, status=$7, modified_at=now()
         WHERE id=$8`,
        [
          snapshot.object_id,
          snapshot.object_name_raw,
          snapshot.employees,
          snapshot.date,
          snapshot.total,
          snapshot.comment,
          snapshot.status,
          id,
        ],
      );
      await client.query(`DELETE FROM record_items WHERE record_id = $1`, [id]);
    } else {
      // Запись была удалена — восстанавливаем строку с тем же id (последовательность
      // id не откатывается назад, так что коллизий с новыми записями не будет).
      await client.query(
        `INSERT INTO records (id, object_id, object_name_raw, employees, claimed_by, created_by_user_id,
            date, total, comment, status, created_at, modified_by, modified_by_user_id, modified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          snapshot.object_id,
          snapshot.object_name_raw,
          snapshot.employees,
          snapshot.claimed_by,
          snapshot.created_by_user_id,
          snapshot.date,
          snapshot.total,
          snapshot.comment,
          snapshot.status,
          snapshot.created_at,
          snapshot.modified_by,
          snapshot.modified_by_user_id,
          snapshot.modified_at,
        ],
      );
      await client.query(
        `SELECT setval(pg_get_serial_sequence('records','id'), (SELECT MAX(id) FROM records))`,
      );
    }

    for (let i = 0; i < (snapshot.items || []).length; i++) {
      const item = snapshot.items[i];
      const { rows: itemRows } = await client.query(
        `INSERT INTO record_items (record_id, name, unit, qty, price, sum, manual, sort_order, work_type_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [id, item.name, item.unit, item.qty, item.price, item.sum, !!item.manual, i, item.work_type_id || null],
      );
      const itemId = itemRows[0].id;
      for (const share of item.shares || []) {
        await client.query(
          `INSERT INTO record_item_shares (record_item_id, employee_name, qty) VALUES ($1,$2,$3)`,
          [itemId, share.employee_name, share.qty],
        );
      }
    }

    if (!exists[0]) {
      // Фото восстанавливаем из корзины, куда их унёс DELETE (см. records.js).
      await client.query(`DELETE FROM record_photos WHERE record_id = $1`, [id]);
      const trashName = snapshot._photos_trash_dir;
      if (trashName && restorePhotosFromTrash(id, trashName)) {
        for (let i = 0; i < (snapshot.photos || []).length; i++) {
          await client.query(
            `INSERT INTO record_photos (record_id, file_path, sort_order) VALUES ($1,$2,$3)`,
            [id, snapshot.photos[i], i],
          );
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function restoreRequest(id, snapshot) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: exists } = await client.query(`SELECT id FROM requests WHERE id = $1`, [id]);

    if (exists[0]) {
      // Заявка ещё в базе (правка или мягкое удаление) — откатываем поля.
      await client.query(
        `UPDATE requests SET status=$1, resolved_name=$2, resolved_unit=$3, resolved_price=$4,
           reject_reason=$5, resolved_at=$6, rejected_at=$7
         WHERE id=$8`,
        [
          snapshot.status,
          snapshot.resolved_name,
          snapshot.resolved_unit,
          snapshot.resolved_price,
          snapshot.reject_reason,
          snapshot.resolved_at,
          snapshot.rejected_at,
          id,
        ],
      );
    } else {
      // Заявка была удалена насовсем (admin) — восстанавливаем строку и переписку.
      await client.query(
        `INSERT INTO requests (id, text, submitted_by, status, resolved_name, resolved_unit,
            resolved_price, reject_reason, created_at, resolved_at, rejected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          snapshot.text,
          snapshot.submitted_by,
          snapshot.status,
          snapshot.resolved_name,
          snapshot.resolved_unit,
          snapshot.resolved_price,
          snapshot.reject_reason,
          snapshot.created_at,
          snapshot.resolved_at,
          snapshot.rejected_at,
        ],
      );
      await client.query(
        `SELECT setval(pg_get_serial_sequence('requests','id'), (SELECT MAX(id) FROM requests))`,
      );

      for (const c of snapshot.comments || []) {
        await client.query(
          `INSERT INTO request_comments (request_id, author, author_user_id, text, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, c.author, c.author_user_id, c.text, c.created_at],
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
