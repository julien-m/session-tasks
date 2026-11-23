// Scoped read-only adapter for the native Codex summary list.
const { execFile } = require("node:child_process");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");

const query = promisify(execFile);
const database = join(homedir(), "Library", "Application Support", "Session Tasks", "tasks.sqlite3");
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageSize = 50;

/** Returns task titles and states for one local chat, without task content or attachment bytes. */
async function readBoard(threadId, openDatabase = database) {
	if (typeof threadId !== "string" || !identifier.test(threadId)) return { status: "unavailable" };
	// Only hexadecimal UTF-8 bytes enter the CLI bind expression, independent of the SQL statement.
	const threadBinding = `.parameter set :thread "CAST(X'${Buffer.from(threadId).toString("hex")}' AS TEXT)"`;
	const sql = `SELECT task.id, task.state, task_revision.title, count(*) OVER () AS total
		FROM board JOIN task ON task.scope = board.scope
		JOIN task_revision ON task_revision.task_id = task.id AND task_revision.revision = task.revision
		WHERE board.thread_id = :thread AND task.state <> 'cancelled'
		ORDER BY task.ordinal LIMIT ${pageSize}`;
	try {
		const { stdout } = await query(
			"/usr/bin/sqlite3",
			["-batch", "-readonly", "-json", "-init", "/dev/null", "-cmd", threadBinding, openDatabase, sql],
			{
				timeout: 1800,
				maxBuffer: 128 * 1024,
			},
		);
		const rows = JSON.parse(stdout || "[]");
		return {
			status: "ready",
			total: rows[0]?.total ?? 0,
			tasks: rows.map(({ id, state, title }) => ({ id, state, title })),
		};
	} catch {
		// SQLite may be unavailable or busy. The renderer keeps its last snapshot for this chat.
		return { status: "unavailable" };
	}
}

module.exports = { readBoard };
