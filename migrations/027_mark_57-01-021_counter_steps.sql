UPDATE work_types
SET is_counter_step = true,
    step_unit_label = '5 мм толщины'
WHERE gesn_code IN (
  '57-01-021-04','57-01-021-05','57-01-021-06',
  '57-01-021-10','57-01-021-11','57-01-021-12'
);

INSERT INTO schema_migrations (filename) VALUES ('027_mark_57-01-021_counter_steps.sql') ON CONFLICT DO NOTHING;
