-- Сообщение мастеру при одобрении заявки на новую позицию: куратор/админ
-- добавляет позицию в справочник отдельно ("Добавить в справочник"), а в
-- заявке остаётся только текст — путь и название внесённой позиции. Ни к
-- work_types.id, ни к какой-либо другой таблице не привязывается. Кто и когда
-- одобрил — по-прежнему resolved_by/resolved_at (миграция 011), отдельные
-- responded_* не нужны.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS response_message TEXT;

INSERT INTO schema_migrations (filename) VALUES ('026_add_request_response_message.sql') ON CONFLICT DO NOTHING;
