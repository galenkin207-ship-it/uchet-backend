-- Фото-отчёты по объекту: мастер загружает фото по объекту за день без вида
-- работ, сотрудников и объёмов (src/routes/object-photos.js). Это не записи —
-- на суммы, статусы и work-summary не влияют.
--
-- file_path — без S3_PREFIX, вида "object-photos/<objectId>/<uuid>.jpg".
-- Удаление фото — мягкое (deleted_at/deleted_by), файлы в S3 остаются.
-- При удалении объекта строки удаляет ON DELETE CASCADE, файлы в S3 по
-- префиксу "object-photos/<id>/" чистит бэкенд (best-effort).
-- Типы object_id/user_id — INTEGER, как во всех ссылках на objects(id)/users(id)
-- в предыдущих миграциях (007, 013 и др.).
-- Применить: sudo -u postgres psql -d uchet_db_staging -f 033_add_object_photos.sql

CREATE TABLE IF NOT EXISTS object_photos (
  id SERIAL PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  comment TEXT,
  photo_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_object_photos_object_date
  ON object_photos (object_id, photo_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_object_photos_created_at ON object_photos (created_at);
CREATE INDEX IF NOT EXISTS idx_object_photos_user_id ON object_photos (user_id);

-- Права для прикладного пользователя БД (без этого — Postgres aclcheck_error при первом запросе).
GRANT SELECT, INSERT, UPDATE, DELETE ON object_photos TO uchet_app;
GRANT USAGE, SELECT ON SEQUENCE object_photos_id_seq TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('033_add_object_photos.sql') ON CONFLICT DO NOTHING;
