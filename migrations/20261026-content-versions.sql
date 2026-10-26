-- 内容版本快照（2026-10-26）：模板等正文被覆盖前留底，支持回滚。
-- 与 schema.sql 中 content_versions 段保持一致。
CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  editor_id TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (target_type, target_id, version)
);

CREATE INDEX IF NOT EXISTS idx_cv_target ON content_versions(target_type, target_id, version);
