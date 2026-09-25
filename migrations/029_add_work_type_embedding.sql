ALTER TABLE work_types ADD COLUMN IF NOT EXISTS embedding vector(1536);

INSERT INTO schema_migrations (filename) VALUES ('029_add_work_type_embedding.sql') ON CONFLICT DO NOTHING;
