PRAGMA user_version = 1;
CREATE TABLE document_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  state_hash TEXT NOT NULL
);
CREATE TABLE oplog (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  update_bytes BLOB NOT NULL,
  update_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL
);
CREATE TABLE snapshots (
  revision INTEGER PRIMARY KEY CHECK (revision >= 0),
  ast_zstd BLOB NOT NULL,
  ast_hash TEXT NOT NULL,
  loro_snapshot BLOB NOT NULL,
  loro_hash TEXT NOT NULL
);
CREATE VIRTUAL TABLE fts_index USING fts5(node_id UNINDEXED, content);
-- Timeline is a separate lifecycle, not an alias for undo or the recovery log.
CREATE TABLE timeline_events (
  event_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload BLOB NOT NULL
);
