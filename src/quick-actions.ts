/** Scoped persistence and one-use dispatch of saved quick actions. */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CodexProjects } from "./codex-projects.ts";
import { TaskError } from "./contract.ts";
import type { QuickAction, QuickActionInput, QuickActionSuggestion } from "./quick-actions-contract.ts";
import type { TaskRepository } from "./repository.ts";

const MAX_ACTIONS = 200;
const digest = (code: string) => createHash("sha256").update(code).digest("hex");
type ActionRow = Pick<QuickAction, "id" | "revision" | "position" | "title" | "body" | "color"> & {
	chat_scope: string | null;
};

export class QuickActions {
	constructor(
		private readonly db: DatabaseSync,
		private readonly tasks: TaskRepository,
		private readonly projects: CodexProjects,
		private readonly now: () => number = Date.now,
	) {}

	list(scope: string): QuickAction[] {
		const project = this.projects.forThread(this.tasks.threadForScope(scope));
		const rows = this.db
			.prepare("SELECT * FROM quick_action WHERE chat_scope IS NULL OR chat_scope=? ORDER BY position,id")
			.all(scope) as unknown as ActionRow[];
		return rows.map((row) => this.present(row, project));
	}

	get(scope: string, id: string): QuickAction {
		const project = this.projects.forThread(this.tasks.threadForScope(scope));
		return this.present(this.require(scope, id), project);
	}

	save(scope: string, id: string, expectedRevision: number, input: QuickActionInput): QuickAction {
		const project = this.projects.forThread(this.tasks.threadForScope(scope));
		if (input.audience.kind === "projects") {
			const allowed = new Set(this.projects.list().map(({ id }) => id));
			if (input.audience.ids.some((value) => !allowed.has(value))) throw new TaskError("invalid_context");
		}
		return this.tasks.write(() => {
			const current = this.find(scope, id);
			if ((current?.revision ?? 0) !== expectedRevision) throw new TaskError("conflict");
			if (!current && this.db.prepare("SELECT 1 FROM removed_quick_action WHERE id=?").get(id))
				throw new TaskError("conflict");
			const chatScope = input.audience.kind === "chat" ? scope : null;
			if (!current || current.chat_scope !== chatScope) {
				const count = Number(
					this.db.prepare("SELECT COUNT(*) AS count FROM quick_action WHERE chat_scope IS ?").get(chatScope)
						?.count,
				);
				if (count >= MAX_ACTIONS) throw new TaskError("invalid_context");
			}
			if (current)
				this.db
					.prepare(
						"UPDATE quick_action SET revision=revision+1,title=?,body=?,color=?,chat_scope=? WHERE id=?",
					)
					.run(input.title, input.body, input.color, chatScope, id);
			else
				this.db
					.prepare(`INSERT INTO quick_action
					SELECT ?,1,COALESCE(MAX(position),0)+1,?,?,?,? FROM quick_action`)
					.run(id, input.title, input.body, input.color, chatScope);
			this.db.prepare("DELETE FROM quick_action_project WHERE action_id=?").run(id);
			this.db.prepare("DELETE FROM quick_action_dispatch WHERE action_id=?").run(id);
			if (input.audience.kind === "projects") {
				const insert = this.db.prepare("INSERT INTO quick_action_project VALUES (?,?)");
				for (const projectId of input.audience.ids) insert.run(id, projectId);
			}
			return this.present(this.require(scope, id), project);
		});
	}

	remove(scope: string, id: string, revision: number): void {
		this.tasks.assertScope(scope);
		this.tasks.write(() => {
			if (this.require(scope, id).revision !== revision) throw new TaskError("conflict");
			this.db.prepare("INSERT INTO removed_quick_action VALUES (?)").run(id);
			this.db.prepare("DELETE FROM quick_action WHERE id=?").run(id);
		});
	}

	applySuggestion(scope: string, action: QuickAction, suggestion: QuickActionSuggestion): void {
		const color = suggestion.color ?? action.color;
		if (action.title === suggestion.title && action.body === suggestion.body && action.color === color)
			return;
		this.tasks.write(() => {
			const updated = this.db
				.prepare(`UPDATE quick_action SET revision=revision+1,title=?,body=?,color=?
					WHERE id=? AND revision=? AND (chat_scope IS NULL OR chat_scope=?)`)
				.run(suggestion.title, suggestion.body, color, action.id, action.revision, scope);
			if (updated.changes)
				this.db.prepare("DELETE FROM quick_action_dispatch WHERE action_id=?").run(action.id);
		});
	}

	move(scope: string, id: string, targetId: string, position: number, targetPosition: number): void {
		this.tasks.assertScope(scope);
		this.tasks.write(() => {
			const source = this.require(scope, id);
			const target = this.require(scope, targetId);
			if (id === targetId || source.position !== position || target.position !== targetPosition)
				throw new TaskError("conflict");
			this.db
				.prepare("UPDATE quick_action SET position=(SELECT MAX(position)+1 FROM quick_action) WHERE id=?")
				.run(id);
			const update = this.db.prepare("UPDATE quick_action SET position=? WHERE id=?");
			update.run(position, targetId);
			update.run(targetPosition, id);
		});
	}

	request(scope: string, id: string, revision: number): string {
		return this.tasks.write(() => {
			const project = this.projects.forThread(this.tasks.threadForScope(scope));
			const row = this.require(scope, id);
			if (row.revision !== revision || !this.present(row, project).available) throw new TaskError("conflict");
			const now = this.now();
			this.db.prepare("DELETE FROM quick_action_ticket WHERE expires_at<=?").run(now);
			const code = randomBytes(16).toString("hex");
			this.db
				.prepare("INSERT INTO quick_action_dispatch VALUES (?,?,?,?)")
				.run(scope, digest(code), id, revision);
			return code;
		});
	}

	consume(scope: string, code: string): { title: string; body: string } | undefined {
		return this.tasks.write(() => {
			const project = this.projects.forThread(this.tasks.threadForScope(scope));
			const codeHash = digest(code);
			const ticket =
				this.db
					.prepare(
						"DELETE FROM quick_action_dispatch WHERE scope=? AND code_hash=? RETURNING action_id,revision",
					)
					.get(scope, codeHash) ??
				this.db
					.prepare(`DELETE FROM quick_action_ticket WHERE scope=? AND code_hash=? AND expires_at>?
					RETURNING action_id,revision`)
					.get(scope, codeHash, this.now());
			if (!ticket || typeof ticket.action_id !== "string") return undefined;
			const row = this.find(scope, ticket.action_id);
			if (!row || row.revision !== ticket.revision || !this.present(row, project).available) return undefined;
			return { title: row.title, body: row.body };
		});
	}

	private find(scope: string, id: string): ActionRow | undefined {
		return this.db
			.prepare("SELECT * FROM quick_action WHERE id=? AND (chat_scope IS NULL OR chat_scope=?)")
			.get(id, scope) as unknown as ActionRow | undefined;
	}

	private require(scope: string, id: string): ActionRow {
		const row = this.find(scope, id);
		if (!row) throw new TaskError("not_found");
		return row;
	}

	private present({ chat_scope, ...row }: ActionRow, project?: string): QuickAction {
		const ids = this.db
			.prepare("SELECT project_id FROM quick_action_project WHERE action_id=? ORDER BY project_id")
			.all(row.id)
			.map(({ project_id }) => String(project_id));
		if (chat_scope) return { ...row, audience: { kind: "chat" }, available: true };
		if (ids.length)
			return { ...row, audience: { kind: "projects", ids }, available: !!project && ids.includes(project) };
		return { ...row, audience: { kind: "global" }, available: true };
	}
}
