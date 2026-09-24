UPDATE work_types
SET price = 110,
    has_price = true
WHERE gesn_code IN (
  '57-01-021-04','57-01-021-05','57-01-021-06',
  '57-01-021-10','57-01-021-11','57-01-021-12'
);

INSERT INTO schema_migrations (filename) VALUES ('028_set_57-01-021_step_price.sql') ON CONFLICT DO NOTHING;
