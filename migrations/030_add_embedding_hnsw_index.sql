CREATE INDEX IF NOT EXISTS work_types_embedding_hnsw_idx
ON work_types
USING hnsw (embedding vector_cosine_ops)
WHERE level = 5 AND is_step_item = false;

INSERT INTO schema_migrations (filename) VALUES ('030_add_embedding_hnsw_index.sql') ON CONFLICT DO NOTHING;
