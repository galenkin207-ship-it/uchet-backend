-- Время загрузки фото записи — для «активности объектов за сегодня»
-- (GET /api/objects/today-activity и /api/objects/:id/today, только admin).
-- Раньше в record_photos отдельного времени загрузки не было: фото, догруженное
-- к старой записи, нельзя было отличить от загруженного при её создании.
--
-- Колонка добавляется БЕЗ default, а default ставится отдельной командой:
-- так существующие строки остаются NULL (время их загрузки неизвестно —
-- API для них берёт records.created_at), а не получают время применения
-- миграции, из-за которого все старые фото выглядели бы «загруженными сегодня».
-- INSERT в records.js колонку не указывает — заполнит DEFAULT now().
--
-- Индексы по created_at — для выборки «за сегодня» без полного прохода.
-- Новых таблиц/последовательностей нет: права uchet_app на records и
-- record_photos уже есть.
-- Применить: sudo -u postgres psql -d uchet_db_staging -f 032_add_record_photos_created_at.sql

ALTER TABLE record_photos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE record_photos ALTER COLUMN created_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_record_photos_created_at ON record_photos(created_at);
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);

INSERT INTO schema_migrations (filename) VALUES ('032_add_record_photos_created_at.sql') ON CONFLICT DO NOTHING;
