-- Заявки (requests) хранили только "submitted_by" (ФИО текстом) — надёжной
-- привязки к user_id не было вообще. Из-за этого проверка "своя/чужая заявка"
-- (DELETE /api/requests/:id) и адресная push-рассылка полагались на сравнение
-- по ФИО, что ломается при полных тёзках (не редкость на стройке).
--
-- request_comments.author_user_id уже существовал в схеме и заполняется при
-- создании нового комментария, но у части старых сообщений (созданных до
-- появления этого поля) он может быть NULL — на всякий случай подчищаем и их.
--
-- Бэкафилл ниже — лучшее, что можно сделать по имеющимся данным: сопоставляет
-- по совпадению ФИО. Если у нескольких пользователей одинаковое ФИО, для уже
-- существующих строк это не разрешает неоднозначность (выбирается пользователь
-- с наименьшим id) — так же, как это неявно работало и раньше через
-- findUserIdByName(). Все НОВЫЕ заявки и комментарии после этой миграции
-- всегда получают user_id напрямую из сессии, без поиска по имени.

ALTER TABLE requests ADD COLUMN IF NOT EXISTS submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_requests_submitted_by_user_id ON requests(submitted_by_user_id);

UPDATE requests r
SET submitted_by_user_id = (
  SELECT u.id FROM users u WHERE u.full_name = r.submitted_by ORDER BY u.id LIMIT 1
)
WHERE r.submitted_by_user_id IS NULL;

UPDATE request_comments c
SET author_user_id = (
  SELECT u.id FROM users u WHERE u.full_name = c.author ORDER BY u.id LIMIT 1
)
WHERE c.author_user_id IS NULL;

INSERT INTO schema_migrations (filename) VALUES ('013_add_requests_submitted_by_user_id.sql') ON CONFLICT DO NOTHING;
