-- Ответ на заявку мастера прямо в приложении: куратор/админ закрывает заявку
-- позицией справочника (выбранной или созданной тут же), мастер видит её путь
-- и одной кнопкой вносит в запись (POST /api/requests/:id/complete).
--
-- Новый статус в ENUM request_status НЕ добавляется: «выполнена» — это
-- существующий approved + work_type_id. approved без work_type_id — старые
-- заявки (до этой миграции), показываются как выполненные без кнопки.
--
-- Уже есть и не добавляются (см. 011/026 и исходную схему):
--   resolved_at       — когда заявку выполнили (ставится и при одобрении);
--   reject_reason     — комментарий при отклонении;
--   response_message  — комментарий мастеру при выполнении.
-- Отдельной колонки admin_comment нет — API отдаёт её вычисляемым полем.
--
-- work_type_id — позиция, которой закрыта заявка. Позиции обычно архивируются,
-- а не удаляются; ON DELETE SET NULL — на случай жёсткого удаления.
-- record_id — запись, из формы которой мастер отправил заявку (если была).
--
-- Новых таблиц/последовательностей нет: права uchet_app на requests уже есть.
-- Конкретные id позиций не используются (на staging и prod они разные).
-- Применить: sudo -u postgres psql -d uchet_db_staging -f 031_add_request_work_type_link.sql

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS work_type_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL;
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES records(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_requests_work_type_id ON requests(work_type_id);
CREATE INDEX IF NOT EXISTS idx_requests_record_id ON requests(record_id);

INSERT INTO schema_migrations (filename) VALUES ('031_add_request_work_type_link.sql') ON CONFLICT DO NOTHING;
