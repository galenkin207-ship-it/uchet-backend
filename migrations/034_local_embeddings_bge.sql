-- Переход на локальные эмбеддинги bge-m3 (1024 измерения) вместо OpenAI (1536).
-- Векторы bge заранее посчитаны в колонке embedding_bge. Старые векторы OpenAI
-- остаются в embedding_openai до ручного удаления колонки.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_types' AND column_name = 'embedding_bge'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_types' AND column_name = 'embedding_openai'
  ) THEN
    DROP INDEX IF EXISTS work_types_embedding_hnsw_idx;
    DROP INDEX IF EXISTS work_types_embedding_bge_hnsw_idx;
    ALTER TABLE work_types RENAME COLUMN embedding TO embedding_openai;
    ALTER TABLE work_types RENAME COLUMN embedding_bge TO embedding;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS work_types_embedding_hnsw_idx
  ON work_types USING hnsw (embedding vector_cosine_ops)
  WHERE level = 5 AND is_step_item = false;

INSERT INTO schema_migrations (filename) VALUES ('034_local_embeddings_bge.sql') ON CONFLICT DO NOTHING;

COMMIT;