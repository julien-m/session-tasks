/** Reads only the owning local chat's lifecycle markers to gate panel wake-ups. */
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const chatIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function lastTurnEnded(records: string[]): boolean {
	let ended = false;
	for (const line of records) {
		if (!line) continue;
		const record = JSON.parse(line);
		if (record.type !== "event_msg") continue;
		const event = record.payload;
		switch (event?.type) {
			case "task_complete":
			case "turn_complete":
			case "turn_aborted":
				ended = typeof event.turn_id === "string" && Boolean(event.turn_id);
				break;
			case "task_started":
			case "turn_started":
			case "user_message":
			case "shutdown_complete":
				ended = false;
				break;
		}
	}
	return ended;
}

async function endedInRollout(path: string, threadId: string): Promise<boolean> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.()) return false;
		const head = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
		const { bytesRead: headLength } = await file.read(head, 0, head.length, 0);
		const header = head.subarray(0, headLength).toString("utf8");
		const separator = header.indexOf("\n");
		if (separator < 0) return false;
		const meta = JSON.parse(header.slice(0, separator));
		if (meta.type !== "session_meta" || meta.payload?.id !== threadId) return false;

		const length = Math.min(stat.size, TAIL_BYTES);
		const tail = Buffer.alloc(length);
		const start = stat.size - length;
		const { bytesRead } = await file.read(tail, 0, length, start);
		const latest = await file.stat();
		if (bytesRead !== length || latest.size !== stat.size || latest.mtimeMs !== stat.mtimeMs) return false;
		if (tail.at(-1) !== 10) return false;
		const lines = tail.toString("utf8").split("\n");
		if (start > 0) lines.shift();
		return lastTurnEnded(lines);
	} finally {
		await file.close();
	}
}

/** Uses the UUIDv7 creation date and checks neighboring dates for timezone differences. */
export async function chatCanResume(
	threadId: string,
	sessions = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
): Promise<boolean> {
	if (!chatIdPattern.test(threadId)) return false;
	const createdAt = Number.parseInt(threadId.slice(0, 13).replace("-", ""), 16);
	try {
		for (const offset of [0, -1, 1]) {
			const date = new Date(createdAt + offset * DAY_MS);
			const day = date.toISOString().slice(0, 10).replaceAll("-", "/");
			const directory = join(sessions, day);
			const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
			const matches = entries.filter(
				(entry) =>
					entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`),
			);
			if (matches.length) {
				const match = matches[0];
				return (
					matches.length === 1 && !!match && (await endedInRollout(join(directory, match.name), threadId))
				);
			}
		}
	} catch {
		// An unavailable or changing rollout leaves wake-up to the existing manual action.
	}
	return false;
}
