/** SQLite schema for scoped task identities, immutable revisions and local files. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS board (
  thread_id TEXT NOT NULL PRIMARY KEY CHECK(length(CAST(thread_id AS BLOB)) BETWEEN 1 AND 256),
  scope TEXT NOT NULL UNIQUE CHECK(length(scope)=36)
) STRICT;
CREATE TABLE IF NOT EXISTS board_resume (
  scope TEXT NOT NULL PRIMARY KEY REFERENCES board(scope),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS task (
  ordinal INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
  scope TEXT NOT NULL REFERENCES board(scope),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  serial INTEGER NOT NULL CHECK(serial BETWEEN revision AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('queued','running','blocked','done','cancelled')),
  claim_id TEXT CHECK(length(claim_id)=36),
  assignee TEXT CHECK(length(CAST(assignee AS BLOB)) BETWEEN 1 AND 240),
  receipt TEXT CHECK(length(CAST(receipt AS BLOB)) BETWEEN 1 AND 8192),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  FOREIGN KEY(id,revision) REFERENCES task_revision(task_id,revision) DEFERRABLE INITIALLY DEFERRED,
  CHECK((state='running') = (claim_id IS NOT NULL)),
  CHECK((state IN ('running','blocked','done')) = (assignee IS NOT NULL)),
  CHECK((state IN ('blocked','done')) = (receipt IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS task_scope_order ON task(scope,ordinal);
CREATE INDEX IF NOT EXISTS task_scope_state ON task(scope,state,ordinal);
CREATE TABLE IF NOT EXISTS task_validation (
  task_id TEXT NOT NULL REFERENCES task(id),
  serial INTEGER NOT NULL CHECK(serial BETWEEN 1 AND 9007199254740991),
  observation TEXT NOT NULL CHECK(length(CAST(observation AS BLOB)) BETWEEN 1 AND 1200),
  PRIMARY KEY(task_id,serial)
) STRICT;
CREATE TABLE IF NOT EXISTS task_revision (
  task_id TEXT NOT NULL REFERENCES task(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 240),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 32768),
  mode TEXT NOT NULL CHECK(mode IN ('auto','thread')),
  author TEXT NOT NULL CHECK(author IN ('user','agent')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(task_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS task_generated_title (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision=1),
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 240),
  PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id,revision) REFERENCES task_revision(task_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS attachment (
  task_id TEXT NOT NULL REFERENCES task(id),
  id TEXT NOT NULL CHECK(length(id)=36),
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
  mime TEXT NOT NULL CHECK(length(mime) BETWEEN 3 AND 127),
  data BLOB NOT NULL CHECK(length(data) <= 4194304),
  PRIMARY KEY(task_id,id)
) STRICT;
CREATE TABLE IF NOT EXISTS revision_attachment (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  attachment_id TEXT NOT NULL,
  PRIMARY KEY(task_id,revision,position),
  UNIQUE(task_id,revision,attachment_id),
  FOREIGN KEY(task_id,revision) REFERENCES task_revision(task_id,revision),
  FOREIGN KEY(task_id,attachment_id) REFERENCES attachment(task_id,id)
) STRICT;
CREATE TABLE IF NOT EXISTS task_comment (
  ordinal INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  id TEXT NOT NULL CHECK(length(id)=36),
  author TEXT NOT NULL CHECK(author IN ('agent','user')),
  kind TEXT NOT NULL CHECK(kind IN ('comment','blocker')),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 8192),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,id)
) STRICT;
CREATE INDEX IF NOT EXISTS task_comment_order ON task_comment(task_id,ordinal);
`;
