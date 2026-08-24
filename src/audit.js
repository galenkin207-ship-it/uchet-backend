// Хелпер для записи истории изменений в audit_log.
// before/after — полные снимки сущности (объекты), сохраняются как JSONB.
// executor может быть как pool, так и client транзакции — оба имеют .query(...).
export async function insertAuditLog(
  executor,
  { entityType, entityId, action, actorUserId, actorName, before = null, after = null },
) {
  const { rows } = await executor.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor_user_id, actor_name, before_data, after_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      entityType,
      entityId,
      action,
      actorUserId ?? null,
      actorName ?? "",
      before != null ? JSON.stringify(before) : null,
      after != null ? JSON.stringify(after) : null,
    ],
  );
  return rows[0].id;
}
