BEGIN;

UPDATE work_types
SET is_counter_step = false
WHERE gesn_code IN (
    '06-03-012-03',
    '06-03-012-04',
    '57-01-004-02',
    '57-01-004-03',
    '57-01-004-06',
    '57-01-004-07',
    '57-01-004-08',
    '57-01-004-09'
);

INSERT INTO schema_migrations (filename) VALUES ('020_unset_conflicting_counter_steps.sql') ON CONFLICT DO NOTHING;

COMMIT;
