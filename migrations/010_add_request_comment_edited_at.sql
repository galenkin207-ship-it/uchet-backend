-- Добавляет отметку времени редактирования к сообщениям переписки по заявкам
-- (для отображения "изменено" в чате, как в Телеграме).
ALTER TABLE request_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

INSERT INTO schema_migrations (filename) VALUES ('010_add_request_comment_edited_at.sql') ON CONFLICT DO NOTHING;
