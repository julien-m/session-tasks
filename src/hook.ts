/** Codex lifecycle integration. User-supplied task text never enters the hook output. */
import { z } from "zod";
import { threadId } from "./contract.ts";
import { catalog } from "./messages.ts";
import { openDatabase, TaskRepository } from "./repository.ts";
import { databasePath } from "./runtime.ts";
import { TaskService } from "./task-service.ts";

const eventInput = z.object({
	hook_event_name: z.enum(["UserPromptSubmit", "Stop"]),
	session_id: threadId,
	prompt: z.string().optional(),
	agent_id: z.string().optional(),
	is_subagent: z.boolean().optional(),
	stop_hook_active: z.boolean().optional(),
});
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

/** Supplies a scoped workflow at prompt submission and bounds final queue checks. */
export function taskHook(service: TaskService, input: unknown): object {
	const parsed = eventInput.safeParse(input);
	if (!parsed.success || parsed.data.agent_id || parsed.data.is_subagent) return {};
	const event = parsed.data;
	const scope = service.bind(event.session_id);
	const counts = service.list(scope).counts;
	const workLeft = counts.queued + counts.running;
	if (event.hook_event_name === "Stop") {
		if (!workLeft || event.stop_hook_active) return {};
		return {
			decision: "block",
			reason: `Session Tasks scope=${scope}. Recheck the board once. Continue pending user-authorized work where possible and record concrete blockers. Respect cancellation and do not restart workers whose status is uncertain.`,
		};
	}
	const resuming = event.prompt === catalog("en").resumePrompt || event.prompt === catalog("fr").resumePrompt;
	return {
		hookSpecificOutput: {
			hookEventName: event.hook_event_name,
			additionalContext: [
				`Session Tasks board scope=${scope}. This is the exact board for the current chat. ${workLeft} queued or claimed task(s).`,
				resuming
					? "This is a Session Tasks resume signal. Read and process the existing queued tasks. Do not create a task for this signal."
					: "For a new actionable request, record each distinct user-requested outcome with session_tasks_add and invoke open_session_tasks once when starting the board or when requested. Use the actual scope. Update existing tasks in place when revising them. Leave questions and casual conversation alone.",
				"This installed workflow delegates independent tasks to subagents by default when allowed and available. Keep mode=thread tasks in the parent chat. Parallelize only isolated changes; claim one revision per executor, pass its own instructions and attachments only, and verify the result in the parent before settling.",
				"Never mark a task done before an actual check passes. Record the work performed, check executed, observed result, and inspectable evidence on the task. If verification fails or cannot run, record the exact blocker.",
				"Check session_tasks_list after each task and once before ending. New panel entries arrive in the queue. Follow edits and cancellations; an old claim cannot complete a revised task. Track scoped user work only and settle with evidence or a concrete blocker.",
			].join(" "),
		},
	};
}

async function run(): Promise<void> {
	let bytes = 0;
	const chunks: Buffer[] = [];
	for await (const value of process.stdin) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		bytes += chunk.length;
		if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error("hook_input_too_large");
		chunks.push(chunk);
	}
	const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const database = openDatabase(databasePath());
	try {
		process.stdout.write(JSON.stringify(taskHook(new TaskService(new TaskRepository(database)), input)));
	} finally {
		database.close();
	}
}

if (process.argv[1]?.endsWith("/hook.mjs")) {
	try {
		await run();
	} catch {
		process.stdout.write(
			JSON.stringify({
				systemMessage: "Session Tasks could not read its local queue. Check the installation.",
			}),
		);
	}
}
