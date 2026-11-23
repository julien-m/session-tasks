/** Local installation paths and endpoint configuration. */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 46173;
export const DEFAULT_DB_PATH = join(
	homedir(),
	"Library",
	"Application Support",
	"Session Tasks",
	"tasks.sqlite3",
);

/** Resolves the single database shared by Codex hooks and the supervised service. */
export function databasePath(override = process.env.SESSION_TASKS_DB): string {
	const path = override ?? DEFAULT_DB_PATH;
	if (!isAbsolute(path)) throw new Error("invalid_database_path");
	return path;
}
