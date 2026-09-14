BEGIN;

UPDATE work_types
SET is_counter_step = false
WHERE id IN (9625, 9626, 16057, 16058, 16061, 16062, 16063, 16064);

INSERT INTO schema_migrations (filename) VALUES ('020_unset_conflicting_counter_steps.sql') ON CONFLICT DO NOTHING;

COMMIT;
