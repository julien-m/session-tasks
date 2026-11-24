/** Parameterized SQLite persistence and transactional task snapshots. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
	type Actor,
	type Attachment,
	type BoardFilter,
	type BoardInstructions,
	type InstructionChanges,
	MAX_PAGE,
	type Mode,
	manualCheck,
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
import { SCHEMA } from "./schema.ts";

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
const selectComment = "SELECT id,ordinal,author,kind,body,created_at AS createdAt FROM task_comment";

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
}
const currentContent = `FROM task t JOIN task_revision r ON r.task_id=t.id AND r.revision=t.revision
LEFT JOIN task_generated_title g ON g.task_id=r.task_id AND g.revision=r.revision`;
const orderJoin =
	"LEFT JOIN task_order ordering ON ordering.scope=t.scope AND ordering.task_ordinal=t.ordinal";
const position = "COALESCE(ordering.position,t.ordinal)";
const SELECT_TASK = `SELECT t.*, COALESCE(g.title,r.title) title,
CASE WHEN split.task_id IS NOT NULL THEN r.title ELSE r.body END body,
r.mode, r.author, r.created_at
${currentContent}
LEFT JOIN task_title_split split ON split.task_id=r.task_id AND split.revision=r.revision`;

/** Opens a private SQLite database and initializes its schema. */
export function openDatabase(path: string): DatabaseSync {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
	database.exec("PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
	database.exec(SCHEMA);
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

	/** Verifies that a request names an existing board capability. */
	assertScope(scope: string): void {
		this.threadForScope(scope);
	}

	readInstructions(scope: string): BoardInstructions {
		const row = this.database
			.prepare(`SELECT COALESCE(c.revision,0) chatRevision, COALESCE(c.body,'') chatBody,
				COALESCE(p.revision,0) permanentRevision, COALESCE(p.body,'') permanentBody
			FROM board b
			LEFT JOIN board_instructions c ON c.scope=b.scope
			LEFT JOIN permanent_instructions p ON p.singleton=1
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
				current[mode] = { revision, body };
			}
			return current;
		});
	}

	requestResume(scope: string, codeHash: string, now: number, expiresAt: number): boolean {
		return this.write(() => {
			this.database.prepare("DELETE FROM board_resume_signal WHERE expires_at<=?").run(now);
			const result = this.database
				.prepare(`INSERT INTO board_resume_signal(scope,code_hash,expires_at)
				SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM task WHERE scope=? AND state='queued')`)
				.run(scope, codeHash, expiresAt, scope);
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
	): BoardList {
		const condition = Array.isArray(filter)
			? filter.length
				? filter
						.map((state) => (state === "remaining" ? "t.state IN ('queued','running')" : stateFilters[state]))
						.join(" OR ")
				: stateFilters.all
			: stateFilters[filter];
		const rows = this.database
			.prepare(`SELECT t.id,t.ordinal,${position} position,t.serial,t.revision,COALESCE(${formatted ? "f.title," : ""}g.title,r.title) title,r.mode,t.state,t.assignee,
			CASE WHEN t.state='blocked' THEN substr(t.receipt,1,160) END blockedReason,
			(SELECT count(*) FROM revision_attachment a WHERE a.task_id=t.id AND a.revision=t.revision) attachmentCount
			${currentContent}
			${orderJoin}
			${formatted ? "LEFT JOIN task_reformulation f ON f.task_id=r.task_id AND f.revision=r.revision" : ""}
			WHERE t.scope=? AND ${position}>? AND (${condition}) ORDER BY position LIMIT ?`)
			.all(scope, after, MAX_PAGE + 1) as unknown as BoardList["tasks"];
		const counts: Record<State, number> = { queued: 0, running: 0, blocked: 0, done: 0, cancelled: 0 };
		for (const row of this.database
			.prepare("SELECT state,count(*) count FROM task WHERE scope=? GROUP BY state")
			.all(scope))
			counts[row.state as State] = Number(row.count);
		const tasks = rows.slice(0, MAX_PAGE);
		return { tasks, counts, next: rows.length > MAX_PAGE ? (tasks.at(-1)?.position ?? null) : null };
	}

	addComment(
		taskId: string,
		commentId: string,
		author: Actor,
		kind: TaskComment["kind"],
		body: string,
		now: number,
	): TaskComment {
		this.database
			.prepare(`INSERT INTO task_comment (task_id,id,author,kind,body,created_at)
			VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,id) DO NOTHING`)
			.run(taskId, commentId, author, kind, body, now);
		const comment = this.database
			.prepare(`${selectComment} WHERE task_id=? AND id=?`)
			.get(taskId, commentId) as unknown as TaskComment;
		if (comment.author !== author || comment.kind !== kind || comment.body !== body)
			throw new TaskError("conflict");
		return comment;
	}

	comments(taskId: string, before: number): CommentsPage {
		const rows = this.database
			.prepare(`${selectComment} WHERE task_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?`)
			.all(taskId, before, MAX_PAGE + 1) as unknown as TaskComment[];
		const comments = rows.slice(0, MAX_PAGE);
		return {
			comments: comments.reverse(),
			next: rows.length > MAX_PAGE ? (comments[0]?.ordinal ?? null) : null,
		};
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
