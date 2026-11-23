/** Parameterized SQLite persistence and transactional task snapshots. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
	type Actor,
	type Attachment,
	MAX_PAGE,
	type Mode,
	type Revision,
	type State,
	type Task,
	TaskError,
	type TaskSummary,
	type Verification,
	verification,
} from "./contract.ts";
import { SCHEMA } from "./schema.ts";

function readVerification(stored: string | null): Verification | undefined {
	if (!stored?.startsWith("{")) return undefined;
	try {
		const parsed = verification.safeParse(JSON.parse(stored));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
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
	tasks: TaskSummary[];
	counts: Record<State, number>;
	next: number | null;
}
const SELECT_TASK = `SELECT t.*, r.title, r.body, r.mode, r.author, r.created_at
FROM task t JOIN task_revision r ON r.task_id=t.id AND r.revision=t.revision`;

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
		return {
			...this.revision(row.id, row),
			id: row.id,
			ordinal: row.ordinal,
			serial: row.serial,
			state: row.state,
			assignee: row.assignee,
			receipt: proof ? [proof.work, proof.check, proof.result, proof.evidence].join("\n") : row.receipt,
			...(proof ? { verification: proof } : {}),
			updatedAt: row.updated_at,
		};
	}

	/** Reads a keyset page and per-board state counts. */
	list(scope: string, after: number, cancelled: boolean): BoardList {
		const filter = cancelled ? "t.state='cancelled'" : "t.state!='cancelled'";
		const rows = this.database
			.prepare(`SELECT t.id,t.ordinal,t.serial,t.revision,r.title,r.mode,t.state,t.assignee,
			CASE WHEN t.state='blocked' THEN substr(t.receipt,1,160) END blockedReason,
			(SELECT count(*) FROM revision_attachment a WHERE a.task_id=t.id AND a.revision=t.revision) attachmentCount
			FROM task t JOIN task_revision r ON r.task_id=t.id AND r.revision=t.revision
			WHERE t.scope=? AND t.ordinal>? AND ${filter} ORDER BY t.ordinal LIMIT ?`)
			.all(scope, after, MAX_PAGE + 1) as unknown as TaskSummary[];
		const counts: Record<State, number> = { queued: 0, running: 0, blocked: 0, done: 0, cancelled: 0 };
		for (const row of this.database
			.prepare("SELECT state,count(*) count FROM task WHERE scope=? GROUP BY state")
			.all(scope))
			counts[row.state as State] = Number(row.count);
		const tasks = rows.slice(0, MAX_PAGE);
		return { tasks, counts, next: rows.length > MAX_PAGE ? (tasks.at(-1)?.ordinal ?? null) : null };
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
