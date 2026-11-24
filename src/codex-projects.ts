/** Reads local Codex project identities and current chat membership without modifying Codex state. */
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type InstructionProject, instructionProjectId } from "./contract.ts";

export interface CodexProjects {
	list(): InstructionProject[];
	forThread(thread: string): string | undefined;
}

/** Use the local app's identity, never the chat working directory or a user-provided display name. */
export function localCodexProjects(
	path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "state_5.sqlite"),
): CodexProjects {
	function read<T>(query: (db: DatabaseSync) => T, fallback: T): T {
		try {
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				return query(db);
			} finally {
				db.close();
			}
		} catch {
			return fallback;
		}
	}
	return {
		list: () =>
			read(
				(db) =>
					db
						.prepare(`SELECT p.id,p.name,
							(SELECT COUNT(*) FROM threads t WHERE t.project_id=p.id) AS chatCount
							FROM projects p ORDER BY p.position,p.id`)
						.all()
						.filter(
							(row) => instructionProjectId.safeParse(row.id).success && typeof row.name === "string",
						) as unknown as InstructionProject[],
				[],
			),
		forThread: (thread) =>
			read((db) => {
				const row = db
					.prepare("SELECT p.id FROM threads t JOIN projects p ON p.id=t.project_id WHERE t.id=?")
					.get(thread);
				const parsed = instructionProjectId.safeParse(row?.id);
				return parsed.success ? parsed.data : undefined;
			}, undefined),
	};
}
