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
    SELECT r.id, r.submitted_by, r.submitted_by_user_id, r.status,
      COALESCE(
        json_agg(
          json_build_object('id', c.id, 'author', c.author, 'author_user_id', c.author_user_id)
          ORDER BY c.created_at
        ) FILTER (WHERE c.id IS NOT NULL),
        '[]'
      ) AS comments
    FROM requests r
    LEFT JOIN request_comments c ON c.request_id = r.id
    GROUP BY r.id
  `);

  // "Моя заявка" — по user_id, если он известен; на старые заявки без
  // привязки (пользователь с тех пор удалён) — fallback на сравнение по ФИО.
  function isMine(authorUserId, authorName) {
    return authorUserId != null ? authorUserId === user.id : authorName === user.full_name;
  }

  const isForeman = user.role === "user";
  const visible = isForeman
    ? allRequests.filter((r) => isMine(r.submitted_by_user_id, r.submitted_by))
    : allRequests;

  const items = [];
  for (const r of visible) {
    items.push({ id: `${r.id}-new`, authorUserId: r.submitted_by_user_id, author: r.submitted_by });
    if (r.status === "deleted") {
      items.push({ id: `${r.id}-deleted`, authorUserId: r.submitted_by_user_id, author: r.submitted_by });
    }
    for (const c of r.comments) {
      items.push({ id: String(c.id), authorUserId: c.author_user_id, author: c.author });
    }
  }

  const { rows: readRows } = await pool.query(
    `SELECT item_id FROM notification_reads WHERE user_id = $1`,
    [user.id],
  );
  const readSet = new Set(readRows.map((r) => r.item_id));

  let count = 0;
  for (const item of items) {
    if (!isMine(item.authorUserId, item.author) && !readSet.has(item.id)) count += 1;
  }
  return count;
}
