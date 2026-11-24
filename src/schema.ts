/** SQLite schema for scoped task identities, immutable revisions and local files. */
export const MAX_STOP_PASSES = 3;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS board (
  thread_id TEXT NOT NULL PRIMARY KEY CHECK(length(CAST(thread_id AS BLOB)) BETWEEN 1 AND 256),
  scope TEXT NOT NULL UNIQUE CHECK(length(scope)=36)
) STRICT;
CREATE TABLE IF NOT EXISTS board_panel_view (
  scope TEXT NOT NULL PRIMARY KEY REFERENCES board(scope) ON DELETE CASCADE,
  tab INTEGER NOT NULL CHECK(tab BETWEEN 0 AND 2),
  filters INTEGER NOT NULL CHECK(filters BETWEEN 0 AND 8),
  instruction_history INTEGER NOT NULL CHECK(instruction_history IN (0,1)),
  task_cursor INTEGER NOT NULL CHECK(task_cursor BETWEEN 0 AND 9007199254740991),
  scroll_top INTEGER NOT NULL CHECK(scroll_top BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE IF NOT EXISTS quick_action (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  revision INTEGER NOT NULL CHECK(revision>=1),
  position INTEGER NOT NULL UNIQUE CHECK(position>=1),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 48),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 8192),
  color TEXT CHECK(length(color)=7 AND substr(color,1,1)='#' AND substr(color,2) NOT GLOB '*[^0-9A-F]*'),
  chat_scope TEXT REFERENCES board(scope)
) STRICT;
CREATE INDEX IF NOT EXISTS quick_action_scope ON quick_action(chat_scope,position);
CREATE TABLE IF NOT EXISTS removed_quick_action (
  id TEXT PRIMARY KEY CHECK(length(id)=36)
) STRICT;
CREATE TABLE IF NOT EXISTS quick_action_project (
  action_id TEXT NOT NULL REFERENCES quick_action(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK(length(project_id)=36),
  PRIMARY KEY(action_id,project_id)
) STRICT;
CREATE TABLE IF NOT EXISTS quick_action_ticket (
  scope TEXT NOT NULL REFERENCES board(scope),
  action_id TEXT NOT NULL REFERENCES quick_action(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
  revision INTEGER NOT NULL CHECK(revision>=1),
  expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  PRIMARY KEY(scope,action_id),
  UNIQUE(scope,code_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS board_instructions (
  scope TEXT NOT NULL PRIMARY KEY REFERENCES board(scope),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 4096)
) STRICT;
CREATE TABLE IF NOT EXISTS permanent_instructions (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 4096)
) STRICT;
CREATE TABLE IF NOT EXISTS instruction_entry (
  ordinal INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
  scope TEXT REFERENCES board(scope),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  body TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
  CHECK((removed=1 AND body='') OR (removed=0 AND length(CAST(body AS BLOB)) BETWEEN 1 AND 4096))
) STRICT;
CREATE INDEX IF NOT EXISTS instruction_entry_scope ON instruction_entry(scope,ordinal);
CREATE TABLE IF NOT EXISTS instruction_binding (
  entry_id TEXT NOT NULL REFERENCES instruction_entry(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('chat','global','project')),
  target TEXT NOT NULL CHECK((kind='global' AND target='') OR (kind!='global' AND length(target)=36)),
  chat_scope TEXT GENERATED ALWAYS AS (CASE WHEN kind='chat' THEN target END) VIRTUAL REFERENCES board(scope),
  PRIMARY KEY(entry_id,kind,target)
) STRICT;
CREATE INDEX IF NOT EXISTS instruction_binding_target ON instruction_binding(kind,target,entry_id);
CREATE TABLE IF NOT EXISTS instruction_project_audience (
  entry_id TEXT NOT NULL PRIMARY KEY REFERENCES instruction_entry(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS instruction_project_exclusion (
  entry_id TEXT NOT NULL REFERENCES instruction_project_audience(entry_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK(
    length(project_id)=36 AND substr(project_id,9,1)='-' AND substr(project_id,14,1)='-'
    AND substr(project_id,19,1)='-' AND substr(project_id,24,1)='-'
    AND length(replace(project_id,'-',''))=32 AND lower(replace(project_id,'-','')) NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(entry_id,project_id)
) STRICT;
CREATE TABLE IF NOT EXISTS instruction_legacy_alias (
  kind TEXT NOT NULL CHECK(kind IN ('chat','global')),
  target TEXT NOT NULL CHECK((kind='global' AND target='') OR (kind='chat' AND length(target)=36)),
  entry_id TEXT NOT NULL UNIQUE REFERENCES instruction_entry(id),
  PRIMARY KEY(kind,target)
) STRICT;
CREATE TABLE IF NOT EXISTS instruction_reformulation (
  entry_id TEXT NOT NULL PRIMARY KEY REFERENCES instruction_entry(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 240),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 32768)
) STRICT;
CREATE TABLE IF NOT EXISTS board_resume_signal (
  scope TEXT NOT NULL REFERENCES board(scope),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  PRIMARY KEY(scope,code_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS board_resume_signal_expiry ON board_resume_signal(expires_at);
CREATE TABLE IF NOT EXISTS board_stop_checkpoint (
  scope TEXT NOT NULL PRIMARY KEY REFERENCES board(scope) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL CHECK(length(CAST(fingerprint AS BLOB))=64 AND instr(fingerprint,char(0))=0 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  pass_count INTEGER NOT NULL CHECK(pass_count BETWEEN 1 AND ${MAX_STOP_PASSES})
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
CREATE UNIQUE INDEX IF NOT EXISTS task_scope_ordinal ON task(scope,ordinal);
CREATE INDEX IF NOT EXISTS task_scope_state ON task(scope,state,ordinal);
-- An override permutes existing task ordinals in the same board. The ordinal
-- stays the task identity and the assigned position survives state changes.
CREATE TABLE IF NOT EXISTS task_order (
  scope TEXT NOT NULL,
  task_ordinal INTEGER NOT NULL PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE,
  FOREIGN KEY(scope,task_ordinal) REFERENCES task(scope,ordinal),
  FOREIGN KEY(scope,position) REFERENCES task(scope,ordinal),
  CHECK(task_ordinal != position)
) STRICT;
CREATE TABLE IF NOT EXISTS task_completion (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES task(id),
  completed_at INTEGER NOT NULL CHECK(completed_at >= 0),
  estimated INTEGER NOT NULL DEFAULT 0 CHECK(estimated IN (0,1))
) STRICT;
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
CREATE TABLE IF NOT EXISTS task_edit_notification (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>1),
  PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id,revision) REFERENCES task_revision(task_id,revision) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS task_generated_title (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision=1),
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 240),
  PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id,revision) REFERENCES task_revision(task_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS task_title_split (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision=1),
  PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id,revision) REFERENCES task_generated_title(task_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS task_reformulation (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 240),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 32768),
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
CREATE TABLE IF NOT EXISTS comment_notification (
  comment_ordinal INTEGER PRIMARY KEY REFERENCES task_comment(ordinal) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS optimized_comment (
  comment_ordinal INTEGER PRIMARY KEY REFERENCES task_comment(ordinal) ON DELETE CASCADE,
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND length(CAST(source_digest AS BLOB))=64
    AND source_digest NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE IF NOT EXISTS comment_attachment (
  task_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  attachment_id TEXT NOT NULL,
  PRIMARY KEY(task_id,comment_id,position),
  UNIQUE(task_id,comment_id,attachment_id),
  FOREIGN KEY(task_id,comment_id) REFERENCES task_comment(task_id,id),
  FOREIGN KEY(task_id,attachment_id) REFERENCES attachment(task_id,id)
) STRICT;
`;
