-- Аудит-лог изменений записей (records) и заявок (requests) с возможностью восстановления.
-- Каждая запись — это полный снимок сущности "до" и/или "после" изменения (JSONB),
-- этого достаточно, чтобы откатить правку или восстановить удалённую сущность.

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL,           -- 'record' | 'request'
  entity_id INTEGER NOT NULL,
  action VARCHAR(20) NOT NULL,                -- 'create' | 'update' | 'delete' | 'restore'
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(255) NOT NULL DEFAULT '',
  before_data JSONB,
  after_data JSONB,
  restored_at TIMESTAMP,
  restored_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restored_by_name VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO uchet_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO uchet_app;

INSERT INTO schema_migrations (filename) VALUES ('002_add_audit_log.sql') ON CONFLICT DO NOTHING;
