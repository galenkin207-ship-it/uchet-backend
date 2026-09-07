-- Единоразовый backfill: у уже обработанных (approved/rejected) заявок
-- уведомления ("новая заявка" + переписка по ней) помечаются прочитанными
-- для всех пользователей — чтобы не осталось "зависших" непрочитанных
-- уведомлений по старым решённым заявкам. Дальше это делает сам бэкенд
-- автоматически при смене статуса (см. PUT /api/requests/:id в requests.js).
-- Применить на сервере: sudo -u postgres psql -d uchet_db < 015_mark_processed_request_notifications_read.sql

INSERT INTO notification_reads (user_id, item_id)
SELECT u.id, r.id::text || '-new'
FROM users u
CROSS JOIN requests r
WHERE r.status IN ('approved', 'rejected')
ON CONFLICT DO NOTHING;

INSERT INTO notification_reads (user_id, item_id)
SELECT u.id, c.id::text
FROM users u
CROSS JOIN request_comments c
JOIN requests r ON r.id = c.request_id
WHERE r.status IN ('approved', 'rejected')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (filename) VALUES ('015_mark_processed_request_notifications_read.sql') ON CONFLICT DO NOTHING;
