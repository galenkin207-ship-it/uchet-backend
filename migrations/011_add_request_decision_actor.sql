-- Кто именно одобрил/отклонил заявку — нужно для уведомления автора заявки
-- ("Одобрено"/"Отклонено" в разделе "Уведомления") и чтобы куратор/админ,
-- принявший решение, не видел это же событие как непрочитанное у себя.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(255);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS rejected_by VARCHAR(255);

INSERT INTO schema_migrations (filename) VALUES ('011_add_request_decision_actor.sql') ON CONFLICT DO NOTHING;
