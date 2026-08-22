-- Отслеживание прочитанных уведомлений (заявки/сообщения/удаления) по пользователям.
-- Применить на сервере: sudo -u postgres psql -d uchet_db < add_notification_reads.sql

CREATE TABLE IF NOT EXISTS notification_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_reads TO uchet_app;

-- Единоразовый сброс: всё, что уже существует на момент применения миграции,
-- помечаем прочитанным для всех пользователей — чтобы счётчик уведомлений
-- начал считать только по-настоящему новые события, а не всю старую историю.
INSERT INTO notification_reads (user_id, item_id)
SELECT u.id, r.id::text || '-new'
FROM users u CROSS JOIN requests r
ON CONFLICT DO NOTHING;

INSERT INTO notification_reads (user_id, item_id)
SELECT u.id, r.id::text || '-deleted'
FROM users u CROSS JOIN requests r
WHERE r.status = 'deleted'
ON CONFLICT DO NOTHING;

INSERT INTO notification_reads (user_id, item_id)
SELECT u.id, c.id::text
FROM users u CROSS JOIN request_comments c
ON CONFLICT DO NOTHING;
