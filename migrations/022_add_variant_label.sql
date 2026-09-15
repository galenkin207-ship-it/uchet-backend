BEGIN;

ALTER TABLE work_types ADD COLUMN IF NOT EXISTS variant_label TEXT;

INSERT INTO schema_migrations (filename) VALUES ('022_add_variant_label.sql') ON CONFLICT DO NOTHING;

COMMIT;
