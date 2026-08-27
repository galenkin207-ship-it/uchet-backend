-- Связывает позиции записей (record_items) с видом работы из справочника
-- (work_types), чтобы при изменении цены/названия/единицы измерения вида
-- работы можно было каскадно обновить все записи, где он уже использован —
-- включая уже завершённые (done). История прежних значений не хранится:
-- имя/единица/цена/сумма в record_items всегда синхронизируются с текущим
-- состоянием справочника.
--
-- ON DELETE SET NULL: если вид работы удалили из справочника, уже
-- существующие позиции записей не удаляются и не ломаются — просто
-- перестают быть связаны и сохраняют последние известные значения.

ALTER TABLE record_items
  ADD COLUMN IF NOT EXISTS work_type_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS record_items_work_type_id_idx ON record_items(work_type_id);

INSERT INTO schema_migrations (filename) VALUES ('add_record_item_work_type_link.sql') ON CONFLICT DO NOTHING;
