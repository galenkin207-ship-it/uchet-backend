import { pool } from "./db.js";

/**
 * Считает количество непрочитанных уведомлений (новые заявки, сообщения,
 * удаления) для пользователя — так же, как это делает фронтенд в
 * src/lib/notification-items.ts, только на бэкенде, чтобы можно было передать
 * актуальное число прямо в push-уведомление (для бейджа на иконке приложения,
 * который обновляется даже когда приложение закрыто).
 */
export async function computeUnreadCount(user) {
  const { rows: allRequests } = await pool.query(`
    SELECT r.id, r.submitted_by, r.status,
      COALESCE(
        json_agg(
          json_build_object('id', c.id, 'author', c.author)
          ORDER BY c.created_at
        ) FILTER (WHERE c.id IS NOT NULL),
        '[]'
      ) AS comments
    FROM requests r
    LEFT JOIN request_comments c ON c.request_id = r.id
    GROUP BY r.id
  `);

  const isForeman = user.role === "user";
  const visible = isForeman
    ? allRequests.filter((r) => r.submitted_by === user.full_name)
    : allRequests;

  const items = [];
  for (const r of visible) {
    items.push({ id: `${r.id}-new`, author: r.submitted_by });
    if (r.status === "deleted") {
      items.push({ id: `${r.id}-deleted`, author: r.submitted_by });
    }
    for (const c of r.comments) {
      items.push({ id: String(c.id), author: c.author });
    }
  }

  const { rows: readRows } = await pool.query(
    `SELECT item_id FROM notification_reads WHERE user_id = $1`,
    [user.id],
  );
  const readSet = new Set(readRows.map((r) => r.item_id));

  let count = 0;
  for (const item of items) {
    if (item.author !== user.full_name && !readSet.has(item.id)) count += 1;
  }
  return count;
}
