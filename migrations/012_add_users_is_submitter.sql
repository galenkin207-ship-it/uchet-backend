-- Независимый от роли флаг: пользователь (куратор/админ/обычный) может быть
-- вручную добавлен в список "Кто подал" на страницах отчётов, не меняя свою
-- основную роль (роль user и так уже подписана "Кто подал" везде в UI —
-- этот флаг для куратора/админа, которых тоже нужно иметь возможность
-- выбрать в этом фильтре).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_submitter BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_migrations (filename) VALUES ('012_add_users_is_submitter.sql') ON CONFLICT DO NOTHING;
