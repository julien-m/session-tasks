/** Parameterized SQLite persistence and transactional task snapshots. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
	type Actor,
	type Attachment,
	type BoardFilter,
	type BoardInstructions,
	type BoardNote,
	type BoardPanelView,
	commentBody,
	type InstructionBinding,
	type InstructionChanges,
	type InstructionEntry,
	type InstructionEntryWrite,
	type InstructionMoment,
	type InstructionTarget,
	instructionMoment,
	instructionMomentFlags,
	instructionTargetKey,
	MAX_PAGE,
	type Mode,
	manualCheck,
	type PresentedInstruction,
	panelViewFilters,
	type Reformulation,
	type Revision,
	type State,
	type Task,
	type TaskComment,
	TaskError,
	type TaskSummary,
	type Verification,
	verification,
} from "./contract.ts";
import { keepsMarkdownLinks } from "./markdown-view.ts";
import { BOARD_PANEL_VIEW_SCHEMA, MAX_STOP_PASSES, SCHEMA } from "./schema.ts";

const storedManualCheck = z.object({ userCheck: manualCheck }).strict();

function readVerification(stored: string | null): Verification | undefined {
	if (!stored?.startsWith("{")) return undefined;
	try {
		const parsed = verification.safeParse(JSON.parse(stored));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function readManualValidation(stored: string | null): string | undefined {
	if (!stored?.startsWith('{"userCheck":')) return undefined;
	try {
		const parsed = storedManualCheck.safeParse(JSON.parse(stored));
		return parsed.success ? parsed.data.userCheck : undefined;
	} catch {
		return undefined;
	}
}

const stateFilters = {
	active: "t.state!='cancelled'",
	all: "1=1",
	remaining: "t.state IN ('queued','running','blocked')",
	blocked: "t.state='blocked'",
	done: "t.state='done'",
	cancelled: "t.state='cancelled'",
} satisfies Record<BoardFilter | "active", string>;
const pendingCommentNotifications = `SELECT c.task_id AS taskId,c.id AS commentId FROM comment_notification n
	JOIN task_comment c ON c.ordinal=n.comment_ordinal JOIN task t ON t.id=c.task_id WHERE t.scope=?`;
const pendingEditNotifications = `SELECT n.task_id AS taskId,n.revision FROM task_edit_notification n
	JOIN task t ON t.id=n.task_id WHERE t.scope=?`;
const selectComment = `SELECT id,ordinal,author,kind,CASE WHEN body=' ' THEN '' ELSE body END AS body,
	created_at AS createdAt FROM task_comment`;

export interface CommentsPage {
	comments: TaskComment[];
	next: number | null;
	currentBlocker?: TaskComment;
}

interface TaskRow extends RevisionRow {
	id: string;
	ordinal: number;
	serial: number;
	state: State;
	assignee: string | null;
	claim_id: string | null;
	receipt: string | null;
	updated_at: number;
	firstCreatedAt: number;
	completedAt: number | null;
	completionEstimated: number | null;
}
interface RevisionRow {
	revision: number;
	title: string;
	body: string;
	mode: Mode;
	author: Actor;
	created_at: number;
}
export interface TaskStatus {
	state: State;
	assignee: string | null;
	claim: string | null;
	receipt: string | null;
}
export interface StoredFile {
	id: string;
	name: string;
	mime: string;
	data: Uint8Array;
}
export interface BoardList {
	tasks: Array<TaskSummary & { position: number }>;
	counts: Record<State, number>;
	next: number | null;
	viewport?: { after: number; previousAfter: number | null; latestAgentOrdinal: number };
}
const generatedTitleJoin =
	"LEFT JOIN task_generated_title g ON g.task_id=r.task_id AND g.revision=r.revision";
const titleSplitJoin =
	"LEFT JOIN task_title_split split ON split.task_id=r.task_id AND split.revision=r.revision";
const revisionContent = `COALESCE(g.title,r.title) title,
	CASE WHEN split.task_id IS NOT NULL THEN r.title ELSE r.body END body,r.mode,r.author,r.created_at`;
const currentContent = `FROM task t JOIN task_revision r ON r.task_id=t.id AND r.revision=t.revision
${generatedTitleJoin}`;
const orderJoin =
	"LEFT JOIN task_order ordering ON ordering.scope=t.scope AND ordering.task_ordinal=t.ordinal";
const position = "COALESCE(ordering.position,t.ordinal)";
const taskDates = `(SELECT created_at FROM task_revision initial WHERE initial.task_id=t.id AND initial.revision=1) firstCreatedAt,
	(SELECT completed_at FROM task_completion c WHERE c.task_id=t.id) completedAt,
	(SELECT estimated FROM task_completion c WHERE c.task_id=t.id) completionEstimated`;
const SELECT_TASK = `SELECT t.*, ${taskDates}, ${revisionContent}
${currentContent}
${titleSplitJoin}`;

function commentDigest(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

function replaceCommentBody(
	database: DatabaseSync,
	ordinal: number,
	source: string,
	formatted: string,
): void {
	if (!commentBody.safeParse(formatted).success || !keepsMarkdownLinks(source, formatted)) return;
	const saved = database
		.prepare("INSERT INTO optimized_comment VALUES (?,?) ON CONFLICT(comment_ordinal) DO NOTHING")
		.run(ordinal, commentDigest(source));
	if (saved.changes === 1)
		database.prepare("UPDATE task_comment SET body=? WHERE ordinal=?").run(formatted, ordinal);
}

function migrateCommentReformulations(database: DatabaseSync): void {
	const legacy = database.prepare(
		"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='comment_reformulation'",
	);
	if (!legacy.get()) return;
	if (!database.prepare("SELECT 1 FROM comment_reformulation LIMIT 1").get()) return;
	database.exec("BEGIN IMMEDIATE");
	try {
		const page = database.prepare(`SELECT c.ordinal,c.body AS source,f.body AS formatted
			FROM comment_reformulation f JOIN task_comment c ON c.task_id=f.task_id AND c.id=f.comment_id
			WHERE c.author='user' AND c.kind='comment' AND c.body!=' ' AND c.ordinal>?
			ORDER BY c.ordinal LIMIT 100`);
		let after = 0;
		for (;;) {
			const rows = page.all(after) as unknown as { ordinal: number; source: string; formatted: string }[];
			const last = rows.at(-1);
			if (!last) break;
			for (const { ordinal, source, formatted } of rows)
				replaceCommentBody(database, ordinal, source, formatted);
			after = last.ordinal;
		}
		database.exec("DELETE FROM comment_reformulation");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		database.close();
		throw error;
	}
}

/** Opens a private SQLite database and initializes its schema. */
export function openDatabase(path: string): DatabaseSync {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
	database.exec("PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
	database.exec(SCHEMA);
	const schemaVersion = () => Number(database.prepare("PRAGMA user_version").get()?.user_version);
	if (schemaVersion() < 1) {
		database.exec("BEGIN IMMEDIATE");
		try {
			if (schemaVersion() < 1) {
				const columns = database.prepare("PRAGMA table_info(instruction_entry)").all();
				if (!columns.some((column) => column.name === "project_id"))
					database.exec(`ALTER TABLE instruction_entry ADD COLUMN project_id TEXT
					CHECK(project_id IS NULL OR (scope IS NULL AND length(project_id)=36))`);
				database.exec(`
					CREATE INDEX IF NOT EXISTS instruction_entry_project ON instruction_entry(project_id,ordinal) WHERE project_id IS NOT NULL;
					ALTER TABLE instruction_entry ADD COLUMN created_at INTEGER CHECK(created_at >= 0);
					INSERT INTO instruction_binding(entry_id,kind,target)
					SELECT id, CASE WHEN project_id IS NOT NULL THEN 'project' WHEN scope IS NOT NULL THEN 'chat' ELSE 'global' END,
						COALESCE(project_id,scope,'') FROM instruction_entry WHERE removed=0;
				`);
				const insertEntry = database.prepare(
					"INSERT INTO instruction_entry(id,scope,revision,body) VALUES(?,?,?,?)",
				);
				const insertBinding = database.prepare(
					"INSERT INTO instruction_binding(entry_id,kind,target) VALUES(?,?,?)",
				);
				const insertAlias = database.prepare("INSERT INTO instruction_legacy_alias VALUES(?,?,?)");
				const chatDocuments = database
					.prepare("SELECT scope,revision,body FROM board_instructions WHERE body!=''")
					.all() as {
					scope: string;
					revision: number;
					body: string;
				}[];
				for (const document of chatDocuments) {
					const id = randomUUID();
					insertEntry.run(id, document.scope, document.revision, document.body);
					insertBinding.run(id, "chat", document.scope);
					insertAlias.run("chat", document.scope, id);
				}
				const globalDocument = database
					.prepare("SELECT revision,body FROM permanent_instructions WHERE body!=''")
					.get() as
					| {
							revision: number;
							body: string;
					  }
					| undefined;
				if (globalDocument) {
					const id = randomUUID();
					insertEntry.run(id, null, globalDocument.revision, globalDocument.body);
					insertBinding.run(id, "global", "");
					insertAlias.run("global", "", id);
				}
				database.exec(`DELETE FROM board_instructions; DELETE FROM permanent_instructions;
					INSERT INTO task_completion(task_id,completed_at,estimated)
					SELECT id,updated_at,1 FROM task WHERE state='done';
					PRAGMA user_version=1;`);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			database.close();
			throw error;
		}
	}
	if (schemaVersion() < 2) {
		database.exec("BEGIN IMMEDIATE");
		try {
			if (schemaVersion() < 2) {
				database.exec(`
					ALTER TABLE board_panel_view RENAME TO board_panel_view_previous;
					${BOARD_PANEL_VIEW_SCHEMA}
					INSERT INTO board_panel_view SELECT * FROM board_panel_view_previous;
					DROP TABLE board_panel_view_previous;
					PRAGMA user_version=2;
				`);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			database.close();
			throw error;
		}
	}
	migrateCommentReformulations(database);
	return database;
}

export class TaskRepository {
	constructor(private readonly database: DatabaseSync) {}

	/** Serializes competing writers and rolls back the entire mutation on failure. */
	write<T>(run: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** Returns the existing or newly initialized capability for this exact chat. */
	bind(threadId: string): string {
		return this.write(() => {
			this.database
				.prepare("INSERT INTO board VALUES (?,?) ON CONFLICT(thread_id) DO NOTHING")
				.run(threadId, randomUUID());
			return (
				this.database.prepare("SELECT scope FROM board WHERE thread_id=?").get(threadId) as { scope: string }
			).scope;
		});
	}

	readPanelView(scope: string): BoardPanelView | null {
		this.assertScope(scope);
		const row = this.database
			.prepare(
				"SELECT tab,filters,instruction_history,task_cursor,scroll_top FROM board_panel_view WHERE scope=?",
			)
			.get(scope) as
			| { tab: number; filters: number; instruction_history: number; task_cursor: number; scroll_top: number }
			| undefined;
		return row
			? {
					tab: row.tab,
					filters: panelViewFilters.filter((_, index) => Boolean(row.filters & (1 << index))),
					instructionHistory: row.instruction_history === 1,
					cursor: row.task_cursor,
					scrollTop: row.scroll_top,
				}
			: null;
	}

	savePanelView(scope: string, view: BoardPanelView): void {
		this.assertScope(scope);
		const filters = view.filters.reduce((mask, filter) => mask | (1 << panelViewFilters.indexOf(filter)), 0);
		this.database
			.prepare(`INSERT INTO board_panel_view(scope,tab,filters,instruction_history,task_cursor,scroll_top)
			VALUES (?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET tab=excluded.tab,filters=excluded.filters,
			instruction_history=excluded.instruction_history,task_cursor=excluded.task_cursor,scroll_top=excluded.scroll_top`)
			.run(scope, view.tab, filters, Number(view.instructionHistory), view.cursor, view.scrollTop);
	}

	readNote(scope: string): BoardNote {
		this.assertScope(scope);
		const stored = this.database.prepare("SELECT revision,body FROM board_note WHERE scope=?").get(scope);
		return (stored as BoardNote | undefined) ?? { revision: 0, body: "" };
	}

	saveNote(scope: string, note: BoardNote): { note: BoardNote; changed: boolean } {
		return this.write(() => {
			const current = this.readNote(scope);
			if (
				note.body === current.body &&
				(note.revision === current.revision || note.revision + 1 === current.revision)
			)
				return { note: current, changed: false };
			if (note.revision !== current.revision) throw new TaskError("conflict");
			const revision = current.revision + 1;
			this.database
				.prepare(`INSERT INTO board_note VALUES (?,?,?)
				ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
				.run(scope, revision, note.body);
			return { note: { revision, body: note.body }, changed: true };
		});
	}

	applyNoteFormat(scope: string, note: BoardNote, formatted: string): void {
		this.database
			.prepare("UPDATE board_note SET body=?,revision=revision+1 WHERE scope=? AND revision=? AND body=?")
			.run(formatted, scope, note.revision, note.body);
	}

	clearStopCheckpoint(scope: string): void {
		this.database.prepare("DELETE FROM board_stop_checkpoint WHERE scope=?").run(scope);
	}

	clearFinishCheckpoint(scope: string): void {
		this.database.prepare("DELETE FROM board_finish_checkpoint WHERE scope=?").run(scope);
	}

	checkpointFinish(scope: string, turnId?: string): boolean {
		return (
			this.database
				.prepare(`INSERT INTO board_finish_checkpoint VALUES (?,?)
				ON CONFLICT(scope) DO UPDATE SET turn_id=excluded.turn_id
				WHERE excluded.turn_id IS NOT NULL AND board_finish_checkpoint.turn_id IS NOT excluded.turn_id`)
				.run(scope, turnId ?? null).changes === 1
		);
	}

	/** Records the pending board snapshot before asking Codex for another pass. */
	checkpointStop(
		scope: string,
		continuation: boolean,
	): { pendingComments: boolean; pendingEdits: boolean } | undefined {
		return this.write(() => {
			const previous = continuation
				? (this.database
						.prepare("SELECT fingerprint,pass_count FROM board_stop_checkpoint WHERE scope=?")
						.get(scope) as { fingerprint: string; pass_count: number } | undefined)
				: undefined;
			const passes = previous?.pass_count ?? 0;
			if (passes >= MAX_STOP_PASSES) return undefined;

			const digest = createHash("sha256");
			const addReferences = (kind: string, query: string): boolean => {
				digest.update(`${kind}\n`);
				let pending = false;
				for (const reference of this.database.prepare(query).iterate(scope)) {
					digest.update(`${JSON.stringify(reference)}\n`);
					pending = true;
				}
				return pending;
			};
			const pendingTasks = addReferences(
				"tasks",
				"SELECT ordinal,serial FROM task WHERE scope=? AND state IN ('queued','running') ORDER BY ordinal",
			);
			const pendingComments = addReferences(
				"comments",
				`${pendingCommentNotifications} ORDER BY n.comment_ordinal`,
			);
			const pendingEdits = addReferences(
				"edits",
				`${pendingEditNotifications} ORDER BY t.ordinal,n.revision`,
			);
			if (!pendingTasks && !pendingComments && !pendingEdits) {
				// Another Stop hook can keep the same turn active after this board drains.
				if (!continuation) this.clearStopCheckpoint(scope);
				return undefined;
			}
			const fingerprint = digest.digest("hex");
			if (previous?.fingerprint === fingerprint) return undefined;
			this.database
				.prepare(`INSERT INTO board_stop_checkpoint(scope,fingerprint,pass_count) VALUES (?,?,?)
				ON CONFLICT(scope) DO UPDATE SET fingerprint=excluded.fingerprint,pass_count=excluded.pass_count`)
				.run(scope, fingerprint, passes + 1);
			return { pendingComments, pendingEdits };
		});
	}

	/** Verifies that a request names an existing board capability. */
	assertScope(scope: string): void {
		this.threadForScope(scope);
	}

	readInstructions(scope: string): BoardInstructions {
		const row = this.database
			.prepare(`SELECT COALESCE(c.revision,ce.revision,0) chatRevision, COALESCE(c.body, CASE WHEN cb.entry_id IS NOT NULL THEN ce.body END,'') chatBody,
				COALESCE(p.revision,pe.revision,0) permanentRevision, COALESCE(p.body, CASE WHEN pb.entry_id IS NOT NULL THEN pe.body END,'') permanentBody
			FROM board b
			LEFT JOIN board_instructions c ON c.scope=b.scope
			LEFT JOIN permanent_instructions p ON p.singleton=1
			LEFT JOIN instruction_legacy_alias ca ON ca.kind='chat' AND ca.target=b.scope
			LEFT JOIN instruction_legacy_alias pa ON pa.kind='global' AND pa.target=''
			LEFT JOIN instruction_entry ce ON ce.id=ca.entry_id
			LEFT JOIN instruction_entry pe ON pe.id=pa.entry_id
			LEFT JOIN instruction_binding cb ON cb.entry_id=ce.id AND cb.kind='chat' AND cb.target=b.scope
			LEFT JOIN instruction_binding pb ON pb.entry_id=pe.id AND pb.kind='global'
			WHERE b.scope=?`)
			.get(scope) as
			| {
					chatRevision: number;
					chatBody: string;
					permanentRevision: number;
					permanentBody: string;
			  }
			| undefined;
		if (!row) throw new TaskError("invalid_scope");
		return {
			chat: { revision: row.chatRevision, body: row.chatBody },
			permanent: { revision: row.permanentRevision, body: row.permanentBody },
		};
	}

	private writeInstructionDocument(
		scope: string,
		mode: keyof BoardInstructions,
		revision: number,
		body: string,
	): void {
		const kind = mode === "chat" ? "chat" : "global";
		const target = mode === "chat" ? scope : "";
		const alias = this.database
			.prepare(`SELECT a.entry_id,e.removed OR EXISTS (
				SELECT 1 FROM instruction_project_audience p WHERE p.entry_id=e.id
			) AS detached FROM instruction_legacy_alias a
			JOIN instruction_entry e ON e.id=a.entry_id WHERE a.kind=? AND a.target=?`)
			.get(kind, target) as { entry_id: string; detached: number } | undefined;
		if (alias?.detached)
			this.database
				.prepare("DELETE FROM instruction_legacy_alias WHERE kind=? AND target=?")
				.run(kind, target);
		if (alias && !alias.detached) {
			const entryId = alias.entry_id;
			if (body) {
				this.database
					.prepare("UPDATE instruction_entry SET revision=?,body=? WHERE id=?")
					.run(revision, body, entryId);
				this.addInstructionBinding(scope, entryId, { kind });
			} else {
				this.database.prepare("UPDATE instruction_entry SET revision=? WHERE id=?").run(revision, entryId);
				this.database
					.prepare("UPDATE instruction_reformulation SET revision=? WHERE entry_id=?")
					.run(revision, entryId);
				this.database
					.prepare("DELETE FROM instruction_binding WHERE entry_id=? AND kind=? AND target=?")
					.run(entryId, kind, target);
			}
			return;
		}
		if (mode === "chat") {
			this.database
				.prepare(`INSERT INTO board_instructions(scope,revision,body) VALUES (?,?,?)
				ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
				.run(scope, revision, body);
		} else {
			this.database
				.prepare(`INSERT INTO permanent_instructions(singleton,revision,body) VALUES (1,?,?)
				ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
				.run(revision, body);
		}
	}

	saveInstructions(scope: string, changes: InstructionChanges): BoardInstructions {
		return this.write(() => {
			const current = this.readInstructions(scope);
			for (const mode of ["chat", "permanent"] as const) {
				const change = changes[mode];
				if (!change) continue;
				if (change.revision !== current[mode].revision) throw new TaskError("conflict");
				const body = change.body.trim() ? change.body : "";
				if (body === current[mode].body) continue;
				const revision = change.revision + 1;
				this.writeInstructionDocument(scope, mode, revision, body);
				current[mode] = { revision, body };
			}
			this.checkInstructionCapacity();
			return current;
		});
	}

	/** Older documents remain editable and are projected alongside current bindings. */
	listInstructionEntries(
		scope: string,
		presented = false,
		projectId?: string,
		manageProjects = false,
		library = false,
		moment?: InstructionMoment,
	): PresentedInstruction[] {
		this.assertScope(scope);
		const formatColumns = presented ? "f.title,f.body formattedBody" : "NULL title,NULL formattedBody";
		const formatJoin = presented
			? "LEFT JOIN instruction_reformulation f ON f.entry_id=e.id AND f.revision=e.revision"
			: "";
		const rows = this.database
			.prepare(`SELECT id,revision,body,permanent,projectId,title,formattedBody,createdAt,moments FROM (
				SELECT 'chat' id,revision,body,0 permanent,NULL projectId,-2 ordinal,NULL title,NULL formattedBody,NULL createdAt,$turn moments
				FROM board_instructions WHERE scope=$scope AND body!=''
				UNION ALL
				SELECT 'permanent',revision,body,1,NULL,-1,NULL,NULL,NULL,$turn FROM permanent_instructions WHERE singleton=1 AND body!=''
				UNION ALL
				SELECT e.id,e.revision,e.body,
					EXISTS(SELECT 1 FROM instruction_binding b WHERE b.entry_id=e.id AND b.kind='global'),
					(SELECT MIN(b.target) FROM instruction_binding b WHERE b.entry_id=e.id AND b.kind='project'),
					e.ordinal,${formatColumns},e.created_at,COALESCE(timing.moments,$turn)
				FROM instruction_entry e LEFT JOIN instruction_timing timing ON timing.entry_id=e.id
				${formatJoin} WHERE e.removed=0 AND ($library=1 OR EXISTS (
					SELECT 1 FROM instruction_binding b WHERE b.entry_id=e.id AND (
						b.kind='global' OR (b.kind='chat' AND b.target=$scope) OR
						(b.kind='project' AND (b.target=$project OR $manageProjects=1))
					) AND NOT EXISTS (SELECT 1 FROM instruction_project_audience a WHERE a.entry_id=e.id)
				) OR EXISTS (
					SELECT 1 FROM instruction_project_audience a WHERE a.entry_id=e.id AND (
						$manageProjects=1 OR ($project IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM instruction_project_exclusion x
							WHERE x.entry_id=a.entry_id AND x.project_id=$project
						))
					)
				))
			) WHERE $moment IS NULL OR (moments & $moment)<>0
			ORDER BY CASE WHEN $library=1 AND createdAt IS NULL THEN 1 ELSE 0 END,
				CASE WHEN $library=1 THEN -ordinal ELSE ordinal END`)
			.all({
				$scope: scope,
				$project: projectId ?? null,
				$library: Number(library),
				$manageProjects: Number(manageProjects),
				$turn: instructionMomentFlags.turn,
				$moment: moment ? instructionMomentFlags[moment] : null,
			}) as unknown as Array<
			Omit<InstructionEntry, "permanent" | "projectId" | "createdAt" | "moments"> & {
				permanent: 0 | 1;
				projectId: string | null;
				title: string | null;
				formattedBody: string | null;
				createdAt: number | null;
				moments: number;
			}
		>;
		return rows.map(({ permanent, projectId, title, formattedBody, createdAt, moments, ...entry }) => ({
			...entry,
			permanent: Boolean(permanent),
			...(projectId ? { projectId } : {}),
			...(moments !== instructionMomentFlags.turn
				? {
						moments: instructionMoment.options.filter(
							(value) => (moments & instructionMomentFlags[value]) !== 0,
						),
					}
				: {}),
			...(library
				? {
						bindings: this.instructionBindings(scope, entry.id),
						...(createdAt !== null ? { createdAt } : {}),
					}
				: {}),
			...(title && formattedBody ? { reformulation: { title, body: formattedBody } } : {}),
		}));
	}

	private instructionBindings(scope: string, entryId: string): InstructionBinding[] {
		if (entryId === "chat") return [{ kind: "chat" }];
		if (entryId === "permanent") return [{ kind: "global" }];
		const audience = this.database
			.prepare("SELECT 1 FROM instruction_project_audience WHERE entry_id=?")
			.get(entryId);
		if (audience) {
			const exclusions = this.database
				.prepare("SELECT project_id FROM instruction_project_exclusion WHERE entry_id=? ORDER BY project_id")
				.all(entryId) as { project_id: string }[];
			return [{ kind: "projects_except", projectIds: exclusions.map(({ project_id }) => project_id) }];
		}
		const rows = this.database
			.prepare("SELECT kind,target FROM instruction_binding WHERE entry_id=? ORDER BY kind,target")
			.all(entryId) as { kind: "chat" | "global" | "project"; target: string }[];
		return rows.map(({ kind, target }) =>
			kind === "project"
				? { kind, projectId: target }
				: kind === "chat" && target !== scope
					? { kind: "other_chat" }
					: { kind },
		);
	}

	private checkInstructionCapacity(): void {
		const overLimit = this.database
			.prepare(`SELECT 1 FROM (
			SELECT b.kind,b.target,e.body FROM instruction_binding b
			JOIN instruction_entry e ON e.id=b.entry_id WHERE e.removed=0
			UNION ALL SELECT 'projects_except','',e.body FROM instruction_project_audience a
			JOIN instruction_entry e ON e.id=a.entry_id WHERE e.removed=0
			UNION ALL SELECT 'chat',scope,body FROM board_instructions WHERE body!=''
			UNION ALL SELECT 'global','',body FROM permanent_instructions WHERE body!=''
		) GROUP BY kind,target HAVING COUNT(*)>50 OR SUM(length(CAST(body AS BLOB))+2)>16384 LIMIT 1`)
			.get();
		if (overLimit) throw new TaskError("invalid_context");
	}

	private addInstructionBinding(scope: string, entryId: string, binding: InstructionTarget): void {
		if (binding.kind === "projects_except") {
			// Older clients retain an independent document and its revision when a binding is replaced.
			this.database
				.prepare(`INSERT OR IGNORE INTO board_instructions(scope,revision,body)
				SELECT a.target,e.revision,'' FROM instruction_legacy_alias a
				JOIN instruction_entry e ON e.id=a.entry_id WHERE a.entry_id=? AND a.kind='chat'`)
				.run(entryId);
			this.database
				.prepare(`INSERT OR IGNORE INTO permanent_instructions(singleton,revision,body)
				SELECT 1,e.revision,'' FROM instruction_legacy_alias a
				JOIN instruction_entry e ON e.id=a.entry_id WHERE a.entry_id=? AND a.kind='global'`)
				.run(entryId);
			this.database.prepare("DELETE FROM instruction_legacy_alias WHERE entry_id=?").run(entryId);
			this.database.prepare("INSERT INTO instruction_project_audience(entry_id) VALUES (?)").run(entryId);
			const insertExclusion = this.database.prepare(
				"INSERT INTO instruction_project_exclusion(entry_id,project_id) VALUES (?,?)",
			);
			for (const projectId of binding.projectIds) insertExclusion.run(entryId, projectId);
			return;
		}
		const target = binding.kind === "project" ? binding.projectId : binding.kind === "chat" ? scope : "";
		this.database
			.prepare("INSERT OR IGNORE INTO instruction_binding(entry_id,kind,target) VALUES (?,?,?)")
			.run(entryId, binding.kind, target);
	}

	private deleteInstructionBinding(scope: string, entryId: string, binding: InstructionTarget): void {
		if (binding.kind === "projects_except") {
			this.database.prepare("DELETE FROM instruction_project_audience WHERE entry_id=?").run(entryId);
			return;
		}
		this.database
			.prepare("DELETE FROM instruction_binding WHERE entry_id=? AND kind=? AND target=?")
			.run(
				entryId,
				binding.kind,
				binding.kind === "project" ? binding.projectId : binding.kind === "chat" ? scope : "",
			);
	}

	saveInstructionEntry(
		scope: string,
		input: InstructionEntryWrite,
		materializeLegacy = false,
		manageProjects = false,
		now = Date.now(),
	): PresentedInstruction {
		return this.write(() => {
			const { entryId, expectedRevision, body, permanent, projectId, targets, replaceTargetsFrom, moments } =
				input;
			const current = this.listInstructionEntries(scope, true, undefined, manageProjects, !!targets).find(
				(entry) => entry.id === entryId,
			);
			const inheritedLegacyTarget: InstructionTarget[] | undefined =
				targets?.length === 0 && (entryId === "chat" || entryId === "permanent")
					? [{ kind: entryId === "chat" ? "chat" : "global" }]
					: undefined;
			const requested: InstructionTarget[] = inheritedLegacyTarget ??
				targets ?? [projectId ? { kind: "project", projectId } : { kind: permanent ? "global" : "chat" }];
			const existing = current ? this.instructionBindings(scope, entryId) : [];
			const editable = existing.filter((binding) => binding.kind !== "other_chat");
			const editableKeys = new Set(editable.map(instructionTargetKey));
			const matchesEditableTargets = (values: InstructionTarget[]) =>
				values.length === editable.length &&
				values.every((target) => editableKeys.has(instructionTargetKey(target)));
			if (replaceTargetsFrom && !matchesEditableTargets(replaceTargetsFrom)) throw new TaskError("conflict");
			const sameTargets =
				(replaceTargetsFrom || editable.length === existing.length) && matchesEditableTargets(requested);
			if (
				!targets &&
				(existing.length > 1 || existing[0]?.kind === "projects_except") &&
				!requested.every((target) => editableKeys.has(instructionTargetKey(target)))
			)
				throw new TaskError("conflict");
			if (requested[0]?.kind === "projects_except" && existing.length !== editable.length)
				throw new TaskError("conflict");
			const preserveBindings = !replaceTargetsFrom && (Boolean(targets) || existing.length > 1);
			const toFlags = (values: InstructionMoment[]) =>
				values.reduce((flags, value) => flags | instructionMomentFlags[value], 0);
			const priorMoments = current?.moments ? toFlags(current.moments) : instructionMomentFlags.turn;
			const nextMoments = moments ? toFlags(moments) : priorMoments;
			const same =
				current?.body === body &&
				priorMoments === nextMoments &&
				(sameTargets || (preserveBindings && expectedRevision > 0));
			if (expectedRevision === 0 && current && same) return current;
			if ((current?.revision ?? 0) !== expectedRevision) throw new TaskError("conflict");
			if (same && current) return current;
			const isLegacy = entryId === "chat" || entryId === "permanent";
			if (
				isLegacy &&
				!materializeLegacy &&
				!targets &&
				!projectId &&
				nextMoments === instructionMomentFlags.turn &&
				current?.permanent === permanent
			) {
				this.writeInstructionDocument(scope, entryId, current.revision + 1, body);
				this.checkInstructionCapacity();
				return { id: entryId, revision: current.revision + 1, permanent, body };
			}
			const savedId = isLegacy ? randomUUID() : entryId;
			const revision = current && !isLegacy ? current.revision + 1 : 1;
			if (isLegacy && current) this.writeInstructionDocument(scope, entryId, current.revision + 1, "");
			if (current && !isLegacy) {
				this.database
					.prepare("UPDATE instruction_entry SET body=?,revision=? WHERE id=?")
					.run(body, revision, savedId);
				if (current.body === body)
					this.database
						.prepare("UPDATE instruction_reformulation SET revision=? WHERE entry_id=? AND revision=?")
						.run(revision, savedId, current.revision);
				if (replaceTargetsFrom)
					this.database
						.prepare("DELETE FROM instruction_binding WHERE entry_id=? AND (kind!='chat' OR target=?)")
						.run(savedId, scope);
				else if (!preserveBindings)
					this.database.prepare("DELETE FROM instruction_binding WHERE entry_id=?").run(savedId);
				if (!preserveBindings)
					this.database.prepare("DELETE FROM instruction_project_audience WHERE entry_id=?").run(savedId);
			} else {
				const result = this.database
					.prepare(`INSERT INTO instruction_entry(id,scope,project_id,revision,body,created_at)
					VALUES (?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING`)
					.run(savedId, permanent || projectId ? null : scope, projectId ?? null, body, now);
				if (result.changes !== 1) throw new TaskError("conflict");
			}
			if (!preserveBindings || !current || isLegacy)
				for (const binding of requested) this.addInstructionBinding(scope, savedId, binding);
			if (nextMoments !== instructionMomentFlags.turn)
				this.database
					.prepare(`INSERT INTO instruction_timing VALUES (?,?)
					ON CONFLICT(entry_id) DO UPDATE SET moments=excluded.moments`)
					.run(savedId, nextMoments);
			else if (priorMoments !== nextMoments)
				this.database.prepare("DELETE FROM instruction_timing WHERE entry_id=?").run(savedId);
			this.checkInstructionCapacity();
			const saved = this.listInstructionEntries(scope, true, undefined, true, true).find(
				(entry) => entry.id === savedId,
			);
			if (!saved) throw new TaskError("not_found");
			if (targets) return saved;
			const { bindings: _bindings, createdAt: _createdAt, ...legacy } = saved;
			return legacy;
		});
	}

	setInstructionBindings(
		scope: string,
		entryId: string,
		expectedRevision: number,
		bindings: InstructionTarget[],
		active: boolean,
	): { entryId: string; revision: number } {
		return this.write(() => {
			let resolvedRevision = expectedRevision;
			const current = this.listInstructionEntries(scope, true, undefined, true, true).find(
				(entry) => entry.id === entryId,
			);
			if (current?.revision !== expectedRevision) throw new TaskError("conflict");
			const currentBindings = current.bindings ?? [];
			const existingExclusive = currentBindings.find((binding) => binding.kind === "projects_except");
			const exclusive = bindings.find((binding) => binding.kind === "projects_except");
			if (exclusive || existingExclusive) {
				const same =
					exclusive &&
					existingExclusive &&
					instructionTargetKey(exclusive) === instructionTargetKey(existingExclusive);
				if (active && same) return { entryId, revision: expectedRevision };
				if (!exclusive || (active ? currentBindings.length > 0 : !same)) throw new TaskError("conflict");
				if (active) this.addInstructionBinding(scope, entryId, exclusive);
				else this.deleteInstructionBinding(scope, entryId, exclusive);
				this.checkInstructionCapacity();
				return { entryId, revision: expectedRevision };
			}
			if (entryId === "chat" || entryId === "permanent") {
				const newId = randomUUID();
				this.database
					.prepare("INSERT INTO instruction_entry(id,scope,revision,body) VALUES(?,?,1,?)")
					.run(newId, entryId === "chat" ? scope : null, current.body);
				this.writeInstructionDocument(scope, entryId, expectedRevision + 1, "");
				this.addInstructionBinding(scope, newId, { kind: entryId === "chat" ? "chat" : "global" });
				entryId = newId;
				resolvedRevision = 1;
			}
			for (const binding of bindings) {
				if (active) this.addInstructionBinding(scope, entryId, binding);
				else this.deleteInstructionBinding(scope, entryId, binding);
			}
			this.checkInstructionCapacity();
			return { entryId, revision: resolvedRevision };
		});
	}

	saveInstructionReformulation(
		scope: string,
		entryId: string,
		revision: number,
		generated: Reformulation,
		library = false,
	): void {
		this.assertScope(scope);
		this.database
			.prepare(`INSERT INTO instruction_reformulation(entry_id,revision,title,body)
			SELECT id,revision,?,? FROM instruction_entry
			WHERE id=? AND revision=? AND removed=0 AND (?=1 OR EXISTS (
				SELECT 1 FROM instruction_binding b WHERE b.entry_id=instruction_entry.id
				AND (b.kind!='chat' OR b.target=?)
			) OR EXISTS (SELECT 1 FROM instruction_project_audience a WHERE a.entry_id=instruction_entry.id))
			ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,body=excluded.body
			WHERE instruction_reformulation.revision < excluded.revision`)
			.run(generated.title, generated.body, entryId, revision, Number(library), scope);
	}

	/** Erases an unassigned instruction without reusing its ID or dropping legacy revision history. */
	deleteUnboundInstruction(scope: string, entryId: string, expectedRevision: number): void {
		this.write(() => {
			this.assertScope(scope);
			const deleted = this.database
				.prepare(`UPDATE instruction_entry SET body='',removed=1,revision=revision+1
					WHERE id=? AND revision=? AND removed=0 AND NOT EXISTS (
						SELECT 1 FROM instruction_binding WHERE entry_id=instruction_entry.id
					) AND NOT EXISTS (
						SELECT 1 FROM instruction_project_audience WHERE entry_id=instruction_entry.id
					)`)
				.run(entryId, expectedRevision);
			if (!deleted.changes) throw new TaskError("conflict");
			this.database.prepare("DELETE FROM instruction_reformulation WHERE entry_id=?").run(entryId);
			this.database.prepare("DELETE FROM instruction_timing WHERE entry_id=?").run(entryId);
		});
	}

	removeInstructionEntry(
		scope: string,
		entryId: string,
		expectedRevision: number,
		manageProjects = false,
	): void {
		this.write(() => {
			const current = this.listInstructionEntries(scope, false, undefined, manageProjects).find(
				(entry) => entry.id === entryId,
			);
			if (current?.revision !== expectedRevision) throw new TaskError("conflict");
			if (entryId === "chat" || entryId === "permanent") {
				this.writeInstructionDocument(scope, entryId, current.revision + 1, "");
				return;
			}
			const bindings = this.instructionBindings(scope, entryId).filter(
				(binding) => binding.kind !== "other_chat",
			);
			if (bindings.length !== 1) throw new TaskError("conflict");
			const binding = bindings[0];
			if (!binding) throw new TaskError("conflict");
			this.deleteInstructionBinding(scope, entryId, binding);
		});
	}

	requestResume(scope: string, codeHash: string, now: number, expiresAt: number): boolean {
		return this.write(() => {
			this.database.prepare("DELETE FROM board_resume_signal WHERE expires_at<=?").run(now);
			const result = this.database
				.prepare(`INSERT INTO board_resume_signal(scope,code_hash,expires_at)
				SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM task WHERE scope=? AND state='queued')
				OR EXISTS (${pendingCommentNotifications}) OR EXISTS (${pendingEditNotifications})`)
				.run(scope, codeHash, expiresAt, scope, scope, scope);
			return result.changes === 1;
		});
	}

	consumeResume(scope: string, codeHash: string, now: number): boolean {
		const result = this.database
			.prepare("DELETE FROM board_resume_signal WHERE scope=? AND code_hash=? AND expires_at>?")
			.run(scope, codeHash, now);
		return result.changes === 1;
	}

	/** Resolves the owning chat without accepting a destination from the panel. */
	threadForScope(scope: string): string {
		const board = this.database.prepare("SELECT thread_id FROM board WHERE scope=?").get(scope);
		if (!board) throw new TaskError("invalid_scope");
		return board.thread_id as string;
	}

	hasPendingWork(scope: string): boolean {
		return Boolean(
			this.database
				.prepare("SELECT 1 FROM task WHERE scope=? AND state IN ('queued','running') LIMIT 1")
				.get(scope),
		);
	}

	/** Looks up a task within one board. */
	find(scope: string, taskId: string): TaskRow | undefined {
		return this.database.prepare(`${SELECT_TASK} WHERE t.scope=? AND t.id=?`).get(scope, taskId) as unknown as
			| TaskRow
			| undefined;
	}

	/** Creates a task identity. The caller inserts revision 1 in the same transaction. */
	insert(scope: string, taskId: string, now: number): void {
		this.database
			.prepare("INSERT INTO task(id,scope,revision,serial,state,updated_at) VALUES (?,?,1,1,'queued',?)")
			.run(taskId, scope, now);
	}

	/** Adds immutable content and links the attachments in their displayed order. */
	insertRevision(
		taskId: string,
		revision: Omit<Revision, "attachments">,
		files: StoredFile[],
		attachmentIds: string[],
	): void {
		this.database
			.prepare("INSERT INTO task_revision VALUES (?,?,?,?,?,?,?)")
			.run(
				taskId,
				revision.revision,
				revision.title,
				revision.body,
				revision.mode,
				revision.author,
				revision.createdAt,
			);
		const insert = this.database.prepare("INSERT INTO attachment VALUES (?,?,?,?,?)");
		for (const file of files) insert.run(taskId, file.id, file.name, file.mime, file.data);
		const link = this.database.prepare("INSERT INTO revision_attachment VALUES (?,?,?,?)");
		for (const [position, id] of attachmentIds.entries()) link.run(taskId, revision.revision, position, id);
	}

	/** Adds a generated title only while the original task instructions are current. */
	saveGeneratedTitle(scope: string, taskId: string, title: string, split: boolean): void {
		this.write(() => {
			const result = this.database
				.prepare(`INSERT INTO task_generated_title (task_id,revision,title)
				SELECT id,revision,? FROM task WHERE scope=? AND id=? AND revision=1 AND state!='cancelled'
				ON CONFLICT(task_id,revision) DO NOTHING`)
				.run(title, scope, taskId);
			if (split && result.changes === 1)
				this.database.prepare("INSERT INTO task_title_split (task_id,revision) VALUES (?,1)").run(taskId);
		});
	}

	/** Stores a fitted presentation for the current revision without changing its instructions. */
	saveReformulation(scope: string, taskId: string, revision: number, generated: Reformulation): void {
		this.database
			.prepare(`INSERT INTO task_reformulation(task_id,revision,title,body)
				SELECT t.id,t.revision,?,? FROM task t
				JOIN task_revision source ON source.task_id=t.id AND source.revision=?
				JOIN task_revision current ON current.task_id=t.id AND current.revision=t.revision
				WHERE t.scope=? AND t.id=? AND t.state!='cancelled'
				  AND current.title=source.title AND current.body=source.body
				ON CONFLICT(task_id,revision) DO NOTHING`)
			.run(generated.title, generated.body, revision, scope, taskId);
	}

	readReformulation(taskId: string, revision: number): Reformulation | undefined {
		return this.database
			.prepare("SELECT title,body FROM task_reformulation WHERE task_id=? AND revision=?")
			.get(taskId, revision) as unknown as Reformulation | undefined;
	}

	/** Advances the current snapshot and operational state of a task. */
	update(
		scope: string,
		taskId: string,
		current: TaskRow,
		status: TaskStatus,
		now: number,
		revision = current.revision,
	): void {
		const result = this.database
			.prepare(`UPDATE task SET revision=?, serial=serial+1, state=?, claim_id=?, assignee=?, receipt=?, updated_at=?
			WHERE id=? AND scope=? AND serial=?`)
			.run(
				revision,
				status.state,
				status.claim,
				status.assignee,
				status.receipt,
				now,
				taskId,
				scope,
				current.serial,
			);
		if (result.changes !== 1) throw new TaskError("conflict");
		if (status.state === "done" && current.state !== "done")
			this.database
				.prepare(`INSERT INTO task_completion(task_id,completed_at) VALUES (?,?)
				ON CONFLICT(task_id) DO UPDATE SET completed_at=excluded.completed_at,estimated=0`)
				.run(taskId, now);
		if (status.state === "done" && current.state === "done" && current.completedAt === null)
			this.database
				.prepare("INSERT INTO task_completion VALUES (?,?,1) ON CONFLICT(task_id) DO NOTHING")
				.run(taskId, current.updated_at);
		if (current.state === "blocked" && current.receipt)
			this.addComment(taskId, randomUUID(), "agent", "blocker", current.receipt, current.updated_at);
	}

	/** Maps a stored revision and its attachment metadata without reading file bytes. */
	revision(taskId: string, row: RevisionRow): Revision {
		const attachments = this.database
			.prepare(`SELECT a.id,a.name,a.mime,length(a.data) bytes
			FROM revision_attachment ra JOIN attachment a ON a.task_id=ra.task_id AND a.id=ra.attachment_id
			WHERE ra.task_id=? AND ra.revision=? ORDER BY ra.position`)
			.all(taskId, row.revision) as unknown as Attachment[];
		return {
			revision: row.revision,
			title: row.title,
			body: row.body,
			mode: row.mode,
			author: row.author,
			createdAt: row.created_at,
			attachments,
		};
	}

	/** Maps a stored task to its current state. Claim tokens are never part of the view. */
	task(row: TaskRow): Task {
		const proof = row.state === "done" ? readVerification(row.receipt) : undefined;
		const legacyManual = row.state === "done" ? readManualValidation(row.receipt) : undefined;
		const manual =
			row.state === "done" ? (this.userValidation(row.id, row.serial) ?? legacyManual) : undefined;
		return {
			...this.revision(row.id, row),
			id: row.id,
			ordinal: row.ordinal,
			serial: row.serial,
			state: row.state,
			assignee: row.assignee,
			receipt: proof
				? [proof.work, proof.check, proof.result, proof.evidence].join("\n")
				: (legacyManual ?? row.receipt),
			...(proof ? { verification: proof } : {}),
			...(manual ? { manualValidation: manual } : {}),
			updatedAt: row.updated_at,
			firstCreatedAt: row.firstCreatedAt,
			...(row.state === "done"
				? {
						completedAt: row.completedAt ?? row.updated_at,
						...(row.completedAt === null || row.completionEstimated ? { completedAtEstimated: true } : {}),
					}
				: {}),
		};
	}

	userValidation(taskId: string, serial: number): string | undefined {
		const row = this.database
			.prepare("SELECT observation FROM task_validation WHERE task_id=? AND serial=?")
			.get(taskId, serial);
		return row?.observation as string | undefined;
	}

	saveUserValidation(taskId: string, serial: number, observation: string): void {
		this.database.prepare("INSERT INTO task_validation VALUES (?,?,?)").run(taskId, serial, observation);
	}

	/** Permutes the queued slots in a range without modifying the task snapshots. */
	moveQueued(scope: string, source: number, target: number): void {
		const items = this.database
			.prepare(`SELECT t.ordinal,${position} AS position
				FROM task t ${orderJoin}
				WHERE t.scope=? AND t.state='queued' AND ${position} BETWEEN ? AND ?
				ORDER BY position`)
			.all(scope, Math.min(source, target), Math.max(source, target)) as unknown as Array<{
			ordinal: number;
			position: number;
		}>;
		if (
			items.length < 2 ||
			items[0]?.position !== Math.min(source, target) ||
			items.at(-1)?.position !== Math.max(source, target)
		)
			throw new TaskError("conflict");
		const ordinals = items.map((item) => item.ordinal);
		const from = source < target ? ordinals.shift() : ordinals.pop();
		if (from === undefined) throw new TaskError("conflict");
		if (source < target) ordinals.push(from);
		else ordinals.unshift(from);

		const remove = this.database.prepare("DELETE FROM task_order WHERE scope=? AND task_ordinal=?");
		const assign = this.database.prepare(
			"INSERT INTO task_order (scope,task_ordinal,position) VALUES (?,?,?)",
		);
		for (const ordinal of ordinals) remove.run(scope, ordinal);
		for (const [index, item] of items.entries()) {
			const ordinal = ordinals[index];
			if (ordinal !== undefined && ordinal !== item.position) assign.run(scope, ordinal, item.position);
		}
	}

	queuedPosition(scope: string, taskId: string): number | undefined {
		const row = this.database
			.prepare(`SELECT ${position} position FROM task t ${orderJoin}
			WHERE t.scope=? AND t.id=? AND t.state='queued'`)
			.get(scope, taskId);
		return row?.position as number | undefined;
	}

	/** Reads a keyset page and per-board state counts. */
	list(
		scope: string,
		after: number,
		filter: BoardFilter | "active" | BoardFilter[],
		formatted = false,
		viewport?: { tail: boolean },
	): BoardList {
		const condition = Array.isArray(filter)
			? filter.length
				? filter
						.map((state) => (state === "remaining" ? "t.state IN ('queued','running')" : stateFilters[state]))
						.join(" OR ")
				: stateFilters.all
			: stateFilters[filter];
		const pageBoundary = (boundary: number, pageSize = MAX_PAGE): number =>
			Number(
				this.database
					.prepare(`SELECT ${position} AS position FROM task t ${orderJoin}
				WHERE t.scope=? AND ${position}<=? AND (${condition})
				ORDER BY position DESC LIMIT 1 OFFSET ?`)
					.get(scope, boundary, pageSize)?.position ?? 0,
			);
		const filteredCount = viewport?.tail
			? Number(
					this.database
						.prepare(`SELECT COUNT(*) AS count FROM task t WHERE t.scope=? AND (${condition})`)
						.get(scope)?.count ?? 0,
				)
			: 0;
		const effectiveAfter = viewport?.tail
			? pageBoundary(Number.MAX_SAFE_INTEGER, filteredCount % MAX_PAGE || MAX_PAGE)
			: after;
		const rows = this.database
			.prepare(`SELECT t.id,t.ordinal,${position} position,t.serial,t.revision,${taskDates},t.updated_at,COALESCE(${formatted ? "f.title," : ""}g.title,r.title) title,r.mode,t.state,t.assignee,
			CASE WHEN t.state='blocked' THEN substr(t.receipt,1,161) END blockedReason,
			(SELECT count(*) FROM revision_attachment a WHERE a.task_id=t.id AND a.revision=t.revision) attachmentCount
			${currentContent}
			${orderJoin}
			${formatted ? "LEFT JOIN task_reformulation f ON f.task_id=r.task_id AND f.revision=r.revision" : ""}
			WHERE t.scope=? AND ${position}>? AND (${condition}) ORDER BY position LIMIT ?`)
			.all(scope, effectiveAfter, MAX_PAGE + 1) as unknown as (BoardList["tasks"][number] & {
			updated_at: number;
			completedAt: number | null;
			completionEstimated: number | null;
		})[];
		const counts: Record<State, number> = { queued: 0, running: 0, blocked: 0, done: 0, cancelled: 0 };
		for (const row of this.database
			.prepare("SELECT state,count(*) count FROM task WHERE scope=? GROUP BY state")
			.all(scope))
			counts[row.state as State] = Number(row.count);
		const tasks: BoardList["tasks"] = rows
			.slice(0, MAX_PAGE)
			.map(({ updated_at, completedAt, completionEstimated, ...row }) => ({
				...row,
				...(row.state === "done"
					? {
							completedAt: completedAt ?? updated_at,
							...(completedAt === null || completionEstimated ? { completedAtEstimated: true } : {}),
						}
					: {}),
			}));
		return {
			tasks,
			counts,
			next: rows.length > MAX_PAGE ? (tasks.at(-1)?.position ?? null) : null,
			...(viewport
				? {
						viewport: {
							after: effectiveAfter,
							previousAfter: effectiveAfter ? pageBoundary(effectiveAfter) : null,
							latestAgentOrdinal: Number(
								this.database
									.prepare(`SELECT MAX(t.ordinal) AS ordinal FROM task t
					JOIN task_revision r ON r.task_id=t.id AND r.revision=1
					WHERE t.scope=? AND r.author='agent'`)
									.get(scope)?.ordinal ?? 0,
							),
						},
					}
				: {}),
		};
	}

	addComment(
		taskId: string,
		commentId: string,
		author: Actor,
		kind: TaskComment["kind"],
		body: string,
		now: number,
		files: StoredFile[] = [],
		notify = false,
	): { comment: TaskComment; created: boolean; optimized: boolean } {
		const inserted = this.database
			.prepare(`INSERT INTO task_comment (task_id,id,author,kind,body,created_at)
			VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,id) DO NOTHING`)
			// The original SQLite table rejects zero bytes. A single space is reserved for attachment-only comments.
			.run(taskId, commentId, author, kind, body || " ", now);
		const comment = this.database
			.prepare(`${selectComment} WHERE task_id=? AND id=?`)
			.get(taskId, commentId) as unknown as TaskComment;
		const sourceDigest = this.database
			.prepare("SELECT source_digest FROM optimized_comment WHERE comment_ordinal=?")
			.get(comment.ordinal)?.source_digest;
		const matches = sourceDigest ? sourceDigest === commentDigest(body) : comment.body === body;
		if (comment.author !== author || comment.kind !== kind || !matches) throw new TaskError("conflict");
		if (inserted.changes === 1) {
			if (notify && author === "user" && kind === "comment")
				this.database
					.prepare("INSERT INTO comment_notification(comment_ordinal) VALUES (?)")
					.run(comment.ordinal);
			const insert = this.database.prepare("INSERT INTO attachment VALUES (?,?,?,?,?)");
			const link = this.database.prepare("INSERT INTO comment_attachment VALUES (?,?,?,?)");
			for (const [position, file] of files.entries()) {
				insert.run(taskId, file.id, file.name, file.mime, file.data);
				link.run(taskId, commentId, position, file.id);
			}
		} else {
			const existing = this.database
				.prepare(`SELECT a.id,a.name,a.mime,a.data FROM comment_attachment c JOIN attachment a
					ON a.task_id=c.task_id AND a.id=c.attachment_id WHERE c.task_id=? AND c.comment_id=? ORDER BY c.position`)
				.all(taskId, commentId) as unknown as StoredFile[];
			if (
				files.length !== existing.length ||
				files.some((file, index) => {
					const previous = existing[index];
					return (
						!previous ||
						previous.name !== file.name ||
						previous.mime !== file.mime ||
						Buffer.compare(previous.data, file.data) !== 0
					);
				})
			)
				throw new TaskError("conflict");
		}
		return {
			comment: this.withCommentAttachments(taskId, comment),
			created: inserted.changes === 1,
			optimized: Boolean(sourceDigest),
		};
	}

	hasCommentNotifications(scope: string): boolean {
		return Boolean(this.database.prepare(`${pendingCommentNotifications} LIMIT 1`).get(scope));
	}

	commentNotifications(scope: string): Array<{ taskId: string; comment: TaskComment }> {
		const pending = this.database
			.prepare(`${pendingCommentNotifications} ORDER BY n.comment_ordinal LIMIT 5`)
			.all(scope) as unknown as Array<{ taskId: string; commentId: string }>;
		const read = this.database.prepare(`${selectComment} WHERE task_id=? AND id=?`);
		return pending.map(({ taskId, commentId }) => ({
			taskId,
			comment: this.withCommentAttachments(taskId, read.get(taskId, commentId) as unknown as TaskComment),
		}));
	}

	acknowledgeComment(scope: string, ordinal: number): boolean {
		return (
			this.database
				.prepare(`DELETE FROM comment_notification WHERE comment_ordinal=?
				AND comment_ordinal IN (SELECT c.ordinal FROM task_comment c JOIN task t ON t.id=c.task_id WHERE t.scope=?)`)
				.run(ordinal, scope).changes === 1
		);
	}

	saveCommentReformulation(taskId: string, commentId: string, body: string): void {
		this.write(() => {
			const current = this.database
				.prepare(`SELECT ordinal,body FROM task_comment WHERE task_id=? AND id=?
					AND author='user' AND kind='comment' AND body!=' '
					AND NOT EXISTS (SELECT 1 FROM optimized_comment WHERE comment_ordinal=task_comment.ordinal)`)
				.get(taskId, commentId) as { ordinal: number; body: string } | undefined;
			if (current) replaceCommentBody(this.database, current.ordinal, current.body, body);
		});
	}

	private withCommentAttachments(taskId: string, comment: TaskComment): TaskComment {
		const attachments = this.database
			.prepare(`SELECT a.id,a.name,a.mime,length(a.data) AS bytes FROM comment_attachment c JOIN attachment a
				ON a.task_id=c.task_id AND a.id=c.attachment_id WHERE c.task_id=? AND c.comment_id=? ORDER BY c.position`)
			.all(taskId, comment.id) as unknown as Attachment[];
		return {
			...comment,
			...(attachments.length ? { attachments } : {}),
		};
	}

	comments(taskId: string, before: number): CommentsPage {
		const rows = this.database
			.prepare(`${selectComment} WHERE task_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?`)
			.all(taskId, before, MAX_PAGE + 1) as unknown as TaskComment[];
		const comments = rows.slice(0, MAX_PAGE);
		return {
			comments: comments.reverse().map((comment) => this.withCommentAttachments(taskId, comment)),
			next: rows.length > MAX_PAGE ? (comments[0]?.ordinal ?? null) : null,
		};
	}

	recordEditNotification(taskId: string, revision: number): void {
		this.database
			.prepare("INSERT INTO task_edit_notification(task_id,revision) VALUES (?,?)")
			.run(taskId, revision);
	}

	hasEditNotifications(scope: string): boolean {
		return Boolean(this.database.prepare(`${pendingEditNotifications} LIMIT 1`).get(scope));
	}

	nextEditNotification(scope: string): { taskId: string; before: Revision; after: Revision } | null {
		const next = this.database
			.prepare(`${pendingEditNotifications} ORDER BY t.ordinal,n.revision LIMIT 1`)
			.get(scope) as { taskId: string; revision: number } | undefined;
		if (!next) return null;
		const [after, before] = this.database
			.prepare(`SELECT r.revision,${revisionContent} FROM task_revision r ${generatedTitleJoin} ${titleSplitJoin}
				WHERE r.task_id=? AND r.revision IN (?,?) ORDER BY r.revision DESC`)
			.all(next.taskId, next.revision, next.revision - 1) as unknown as RevisionRow[];
		if (!before || !after) throw new TaskError("not_found");
		return {
			taskId: next.taskId,
			before: this.revision(next.taskId, before),
			after: this.revision(next.taskId, after),
		};
	}

	acknowledgeEdit(scope: string, taskId: string, revision: number): boolean {
		return (
			this.database
				.prepare(`DELETE FROM task_edit_notification WHERE task_id=? AND revision=?
				AND EXISTS (SELECT 1 FROM task WHERE id=? AND scope=?)`)
				.run(taskId, revision, taskId, scope).changes === 1
		);
	}

	/** Reads an immutable revision page in reverse chronological order. */
	history(taskId: string, before: number): Revision[] {
		return (
			this.database
				.prepare("SELECT * FROM task_revision WHERE task_id=? AND revision<? ORDER BY revision DESC LIMIT ?")
				.all(taskId, before, MAX_PAGE) as unknown as RevisionRow[]
		).map((row) => this.revision(taskId, row));
	}

	/** Looks up attachment bytes using the task as its ownership boundary. */
	file(taskId: string, attachmentId: string): StoredFile | undefined {
		const parameters: SQLInputValue[] = [taskId, attachmentId];
		return this.database
			.prepare("SELECT id,name,mime,data FROM attachment WHERE task_id=? AND id=?")
			.get(...parameters) as unknown as StoredFile | undefined;
	}
}
