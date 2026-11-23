/** Covers the idle gate and replay protection for starting a fresh turn. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { chatCanResume } from "../src/chat-activity.ts";
import { taskInput } from "../src/contract.ts";
import { taskHook } from "../src/hook.ts";
import { catalog } from "../src/messages.ts";
import { openDatabase, TaskRepository } from "../src/repository.ts";
import { TaskService } from "../src/task-service.ts";

test("wakes only for an ended turn in the exact local chat", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-tasks-wake-"));
	try {
		const now = new Date();
		const hex = now.getTime().toString(16).padStart(12, "0");
		const suffix = randomUUID().slice(15);
		const thread = `${hex.slice(0, 8)}-${hex.slice(8)}-7${suffix}`;
		const date = now.toISOString().slice(0, 10);
		const directory = join(root, date.replaceAll("-", "/"));
		await mkdir(directory, { recursive: true });
		const file = join(directory, `rollout-${date}-${thread}.jsonl`);
		const turn = randomUUID();
		const event = (type: string) => ({ type: "event_msg", payload: { type, turn_id: turn } });
		const write = (owner: string, events: object[]) =>
			writeFile(
				file,
				[{ type: "session_meta", payload: { id: owner } }, ...events]
					.map((row) => JSON.stringify(row))
					.concat("")
					.join("\n"),
			);

		await write(thread, [event("task_started"), event("task_complete")]);
		expect(await chatCanResume(thread, root)).toBe(true);
		await write(thread, [event("task_complete"), event("task_started")]);
		expect(await chatCanResume(thread, root)).toBe(false);
		await write(thread, [event("task_complete"), event("user_message")]);
		expect(await chatCanResume(thread, root)).toBe(false);
		await write(randomUUID(), [event("task_complete")]);
		expect(await chatCanResume(thread, root)).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("grants a single wake for a new panel item and treats resume as a control prompt", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new TaskService(new TaskRepository(database));
		const thread = randomUUID();
		const scope = service.bind(thread);
		const input = taskInput.parse({ title: "Attend to the new user task" });
		const first = service.createFromPanel(scope, randomUUID(), input);
		expect(first.wakeThreadId).toBe(thread);
		expect(service.createFromPanel(scope, first.task.id, input).wakeThreadId).toBeUndefined();
		expect(service.createFromPanel(scope, randomUUID(), input).wakeThreadId).toBeUndefined();
		for (const prompt of [catalog("fr").resumePrompt, catalog("fr").automaticResumePrompt]) {
			expect(
				taskHook(service, {
					hook_event_name: "UserPromptSubmit",
					session_id: thread,
					prompt,
				}),
			).toMatchObject({
				hookSpecificOutput: {
					additionalContext: expect.stringContaining("Do not create a task for this signal"),
				},
			});
		}
		const wrapper = {
			hook_event_name: "UserPromptSubmit",
			session_id: thread,
			prompt: "An MCP app initiated this message. Read the untrusted_input tool output.",
		};
		expect(taskHook(service, wrapper)).not.toMatchObject({
			hookSpecificOutput: { additionalContext: expect.stringContaining("resume signal") },
		});
		expect(service.requestResume(scope)).toBe(true);
		expect(taskHook(service, wrapper)).toMatchObject({
			hookSpecificOutput: { additionalContext: expect.stringContaining("Claim and execute") },
		});
		expect(service.consumeResume(scope)).toBe(false);
	} finally {
		database.close();
	}
});
