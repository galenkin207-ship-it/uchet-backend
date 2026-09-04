-- Переименование файлов миграций с добавлением числовых префиксов (001_, 002_, ...),
-- чтобы порядок файлов на диске (используется scripts/check-migrations.js через
-- обычную алфавитную сортировку) совпадал с реальным порядком зависимостей.
-- Раньше add_schema_migrations_tracking.sql (создаёт таблицу schema_migrations)
-- сортировался почти в конце списка файлов, хотя несколько более ранних по
-- алфавиту миграций уже пытаются писать в эту ещё не существующую на тот
-- момент таблицу — прогнать все файлы из migrations/ по порядку на пустой
-- базе было невозможно.
--
-- Эта миграция приводит УЖЕ СУЩЕСТВУЮЩИЕ записи в schema_migrations (на
-- staging и проде) к новым именам файлов. Применять ДО деплоя кода с
-- переименованными файлами миграций — иначе check-migrations.js увидит на
-- диске новые имена, которых ещё нет в таблице, и остановит деплой.
--
-- На пустой базе (schema_migrations ещё не существует) этот файл — no-op:
-- 001_add_schema_migrations_tracking.sql создаст таблицу сразу с правильными
-- (уже новыми) именами в своём бэкафилле, переименовывать будет нечего.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    UPDATE schema_migrations SET filename = '001_add_schema_migrations_tracking.sql' WHERE filename = 'add_schema_migrations_tracking.sql';
    UPDATE schema_migrations SET filename = '002_add_audit_log.sql' WHERE filename = 'add_audit_log.sql';
    UPDATE schema_migrations SET filename = '003_add_notification_reads.sql' WHERE filename = 'add_notification_reads.sql';
    UPDATE schema_migrations SET filename = '004_add_object_status.sql' WHERE filename = 'add_object_status.sql';
    UPDATE schema_migrations SET filename = '005_add_push_subscriptions.sql' WHERE filename = 'add_push_subscriptions.sql';
    UPDATE schema_migrations SET filename = '006_add_brigades.sql' WHERE filename = 'add_brigades.sql';
    UPDATE schema_migrations SET filename = '007_add_hidden_objects.sql' WHERE filename = 'add_hidden_objects.sql';
    UPDATE schema_migrations SET filename = '008_add_notification_hides.sql' WHERE filename = 'add_notification_hides.sql';
    UPDATE schema_migrations SET filename = '009_add_record_item_work_type_link.sql' WHERE filename = 'add_record_item_work_type_link.sql';
    UPDATE schema_migrations SET filename = '010_add_request_comment_edited_at.sql' WHERE filename = 'add_request_comment_edited_at.sql';
    UPDATE schema_migrations SET filename = '011_add_request_decision_actor.sql' WHERE filename = 'add_request_decision_actor.sql';
    UPDATE schema_migrations SET filename = '012_add_users_is_submitter.sql' WHERE filename = 'add_users_is_submitter.sql';

    INSERT INTO schema_migrations (filename) VALUES ('000_rename_migration_filenames.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
