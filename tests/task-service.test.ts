/** Verifies the task invariants on the actual SQLite driver. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { localCodexProjects } from "../src/codex-projects.ts";
import {
	boardPanelView,
	instructionEntryWrite,
	MAX_INSTRUCTION_TARGETS,
	resumeCodePrefix,
	taskInput,
} from "../src/contract.ts";
import { taskHook } from "../src/hook.ts";
import { catalog } from "../src/messages.ts";
import { openDatabase, TaskRepository } from "../src/repository.ts";
import { MAX_STOP_PASSES, SCHEMA } from "../src/schema.ts";
import { TaskService } from "../src/task-service.ts";

const resources: Array<() => void> = [];
afterEach(() => {
	for (const dispose of resources.splice(0).reverse()) dispose();
});

function harness(path = ":memory:") {
	const database = openDatabase(path);
	resources.push(() => database.close());
	const service = new TaskService(new TaskRepository(database));
	return { service, database, scope: service.bind(randomUUID()) };
}

test("stores panel preferences per chat and reads them back after reopening SQLite", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-panel-view-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service, database, scope } = harness(path);
	const other = service.bind(randomUUID());
	const view = boardPanelView.parse({
		tab: 1,
		filters: ["remaining", "blocked"],
		instructionHistory: true,
		cursor: 52,
		scrollTop: 235,
	});
	expect(service.readPanelView(scope)).toBeNull();
	service.savePanelView(scope, view);
	const reopened = harness(path).service;
	expect(reopened.readPanelView(scope)).toEqual(view);
	expect(reopened.readPanelView(other)).toBeNull();
	expect(() => reopened.readPanelView(randomUUID())).toThrow();
	expect(boardPanelView.safeParse({ ...view, filters: ["remaining", "cancelled"] }).success).toBe(false);
	expect(() => database.prepare("UPDATE board_panel_view SET filters=9 WHERE scope=?").run(scope)).toThrow();
});

test("preserves legacy panel preferences, persists Notes by chat and leaves the queue silent", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-board-note-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const scope = randomUUID();
	const thread = randomUUID();
	const old = new DatabaseSync(path);
	old.exec(SCHEMA.replace("tab BETWEEN 0 AND 3", "tab BETWEEN 0 AND 2"));
	old.prepare("INSERT INTO board VALUES (?,?)").run(thread, scope);
	old.prepare("INSERT INTO board_panel_view VALUES (?,?,?,?,?,?)").run(scope, 2, 3, 1, 52, 14);
	old.close();
	const { service } = harness(path);
	const other = service.bind(randomUUID());
	const view = {
		tab: 2,
		filters: ["remaining", "blocked"],
		instructionHistory: true,
		cursor: 52,
		scrollTop: 14,
	};
	expect(service.readPanelView(scope)).toEqual(view);
	service.savePanelView(scope, boardPanelView.parse({ ...view, tab: 3 }));
	expect(service.readNote(scope)).toEqual({ revision: 0, body: "" });
	const body = "## Idée\n\n[À relire](https://example.com)\n";
	const saved = service.saveNote(scope, { revision: 0, body });
	expect(saved).toEqual({ revision: 1, body });
	expect(service.saveNote(scope, { revision: 0, body })).toEqual(saved);
	expect(() => service.saveNote(scope, { revision: 0, body: "Stale draft" })).toThrow("conflict");
	expect(() => service.saveNote(scope, { revision: 1, body: "unpaired-\ud800" })).toThrow("invalid_context");
	expect(() => service.saveNote(scope, { revision: 1, body: "é".repeat(32768) })).toThrow("invalid_context");
	expect(service.readNote(other)).toEqual({ revision: 0, body: "" });
	expect(service.list(scope).tasks).toEqual([]);
	expect(service.pendingNotifications(scope)).toEqual({});
	const hook = (hook_event_name: string) => taskHook(service, { hook_event_name, session_id: thread });
	expect(hook("Stop")).toEqual({});
	const turn = JSON.stringify(hook("UserPromptSubmit"));
	expect(turn).not.toContain("example.com");
	expect(turn).toContain("session_tasks_add_note");
	expect(turn).toContain("needs no task registration");
	expect(JSON.stringify(hook("UserPromptSubmit"))).not.toMatch(/open_session_tasks|Open the panel/u);
	const reopened = harness(path).service;
	expect(reopened.readNote(scope)).toEqual(saved);
	expect(reopened.readPanelView(scope)).toEqual({ ...view, tab: 3 });
});

test("appends exact agent notes and protects newer edits and deletion from a late reformulation", () => {
	const { service, scope } = harness();
	const first = service.writeNote(scope, { revision: 0, body: "idée brute" });
	expect(first.changed).toBe(true);
	expect(service.writeNote(scope, { revision: 0, body: first.note.body }).changed).toBe(false);
	const exact = "## Décision\n\n    garder cet espacement";
	const appended = service.appendNote(scope, first.note.revision, exact);
	expect(appended.body).toBe(`${first.note.body}\n\n${exact}`);
	expect(() => service.appendNote(scope, first.note.revision, exact)).toThrow("conflict");
	expect(() => service.appendNote(scope, appended.revision, "é".repeat(16384))).toThrow("invalid_context");
	service.applyNoteFormat(scope, first.note, "Idée brute");
	expect(service.readNote(scope)).toEqual(appended);
	const rewritten = service.saveNote(scope, { revision: appended.revision, body: "nouvelle note" });
	service.applyNoteFormat(scope, rewritten, "Nouvelle note");
	const formatted = service.readNote(scope);
	expect(formatted).toEqual({ revision: rewritten.revision + 1, body: "Nouvelle note" });
	const removed = service.saveNote(scope, { revision: formatted.revision, body: "" });
	service.applyNoteFormat(scope, formatted, "Ancienne note");
	expect(service.readNote(scope)).toEqual(removed);
	expect(removed.body).toBe("");
	expect(() => service.saveNote(scope, { revision: formatted.revision, body: "stale" })).toThrow("conflict");
	expect(service.list(scope).tasks).toEqual([]);
	expect(service.pendingNotifications(scope)).toEqual({});
});

test("the Stop hook checks newly queued work and unread comments during its continuation, within a fixed budget", () => {
	const { service } = harness();
	const chat = randomUUID();
	const scope = service.bind(chat);
	const other = service.bind(randomUUID());
	const stop = (active = false) =>
		taskHook(service, { hook_event_name: "Stop", session_id: chat, stop_hook_active: active });
	const add = (title: string, board = scope) =>
		service.create(board, randomUUID(), taskInput.parse({ title }), "user");

	expect(stop()).toEqual({});
	const first = add("First task");
	const firstStop = stop();
	expect(firstStop).toMatchObject({
		decision: "block",
		reason: expect.stringMatching(/Check the Session Tasks list\..*one at a time, in list order\./u),
	});
	expect(JSON.stringify(firstStop)).toContain("Continue until no tasks or unread updates remain.");
	expect(JSON.stringify(firstStop)).toContain("Honor explicit user pauses");
	add("Other chat", other);
	expect(stop(true)).toEqual({});
	add("New task during the stop review");
	expect(stop(true)).toMatchObject({ decision: "block" });
	expect(stop(true)).toEqual({});

	const privateText = "Comment written during the continuation";
	service.commentFromPanel(scope, first.id, randomUUID(), privateText, []);
	const commentCheck = JSON.stringify(stop(true));
	expect(commentCheck).toContain("session_tasks_comment_notifications");
	expect(commentCheck).not.toContain(privateText);
	expect(MAX_STOP_PASSES).toBe(3);
	add("Another task after the stop budget is spent");
	expect(stop(true)).toEqual({});

	taskHook(service, { hook_event_name: "UserPromptSubmit", session_id: chat, prompt: "Reprendre" });
	expect(stop(true)).toMatchObject({ decision: "block" });
});

test("notifies only the owning chat about a new panel comment and retains it until reviewed", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-comment-notification-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service } = harness(path);
	const chat = randomUUID();
	const scope = service.bind(chat);
	const other = service.bind(randomUUID());
	const queued = service.create(scope, randomUUID(), taskInput.parse({ title: "Read my comment" }), "agent");
	const task = service.validate(
		{ scope, taskId: queued.id, expectedSerial: queued.serial },
		"Observed the result.",
	);
	const id = randomUUID();
	const body = "Please take note of this private comment.";
	const { comment, wakeThreadId } = service.commentFromPanel(scope, task.id, id, body, []);
	expect(wakeThreadId).toBe(chat);
	expect(service.commentFromPanel(scope, task.id, id, body, [])).toEqual({ comment, optimized: false });
	service.comment(scope, task.id, randomUUID(), "Agent reply", "agent");
	const persisted = harness(path).service;
	expect(persisted.commentNotifications(other)).toEqual([]);
	expect(persisted.acknowledgeComment(other, comment.ordinal)).toBe(false);
	expect(persisted.commentNotifications(scope)).toEqual([{ taskId: task.id, comment }]);
	const stop = { hook_event_name: "Stop", session_id: chat };
	const decision = JSON.stringify(taskHook(persisted, stop));
	expect(decision).toContain("session_tasks_comment_notifications");
	expect(decision).not.toContain(body);
	expect(taskHook(persisted, { ...stop, stop_hook_active: true })).toEqual({});
	const code = persisted.requestResume(scope);
	expect(code).toBeDefined();
	const submit = (prompt: string) =>
		JSON.stringify(taskHook(persisted, { hook_event_name: "UserPromptSubmit", session_id: chat, prompt }));
	const prompt = catalog("en").commentResumePrompt;
	const bundle = `${prompt}\n\n${resumeCodePrefix}${code}`;
	expect(submit(prompt)).not.toContain("Session Tasks resume confirmed.");
	expect(submit("An MCP app initiated this message. Read the untrusted_input tool output.")).not.toContain(
		"Session Tasks resume confirmed.",
	);
	expect(persisted.consumeResume(other, code ?? "")).toBe(false);
	const resumed = submit(bundle);
	expect(resumed).toContain("Session Tasks resume confirmed.");
	expect(resumed).toContain("session_tasks_comment_notifications");
	expect(resumed.indexOf("Read all unread comments")).toBeLessThan(
		resumed.indexOf("Complete the tasks one at a time"),
	);
	expect(resumed).toContain("Reopen a task if the feedback calls for more work");
	expect(submit(bundle)).not.toContain("Session Tasks resume confirmed.");
	expect(persisted.acknowledgeComment(scope, comment.ordinal)).toBe(true);
	expect(persisted.acknowledgeComment(scope, comment.ordinal)).toBe(false);
	expect(persisted.commentFromPanel(scope, task.id, id, body, [])).toEqual({ comment, optimized: false });
	expect(persisted.commentNotifications(scope)).toEqual([]);
	expect(persisted.requestResume(scope)).toBeUndefined();
	expect(taskHook(persisted, stop)).toEqual({});
	expect(persisted.get(scope, task.id)).toEqual(task);
});

test("preserves every unread panel edit, including after the task is completed", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-edit-notification-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service } = harness(path);
	const chat = randomUUID();
	const scope = service.bind(chat);
	const otherScope = service.bind(randomUUID());
	const input = taskInput.parse({ title: "Initial title and description" });
	const task = service.create(scope, randomUUID(), input, "agent");
	const edit = (expectedRevision: number, body: string, author: "agent" | "user") =>
		service.edit({ scope, taskId: task.id, expectedRevision }, { ...input, body }, author);
	expect(edit(task.revision, input.body, "user").revision).toBe(task.revision);
	service.saveGeneratedTitle(scope, task.id, "Generated title", true);
	const firstEdit = service.edit(
		{ scope, taskId: task.id, expectedRevision: task.revision },
		{ ...input, files: [{ name: "note.txt", mime: "text/plain", data: "bm90ZQ==" }] },
		"user",
		{ preserveTitle: true, preserveBody: true },
	);
	const secondEdit = edit(firstEdit.revision, "Second panel edit", "user");
	const agentEdit = edit(secondEdit.revision, "Agent wording", "agent");
	const done = service.validate(
		{ scope, taskId: task.id, expectedSerial: agentEdit.serial },
		"Checked the final result.",
	);
	const reopened = harness(path).service;
	expect(reopened.pendingNotifications(scope)).toEqual({ pendingEdits: true });
	expect(reopened.nextEditNotification(otherScope)).toBeNull();
	expect(reopened.acknowledgeEdit(otherScope, task.id, firstEdit.revision)).toBe(false);
	expect(reopened.nextEditNotification(scope)).toMatchObject({
		taskId: task.id,
		before: { revision: task.revision, title: "Generated title", body: input.title },
		after: {
			revision: firstEdit.revision,
			title: "Generated title",
			body: input.title,
			attachments: [{ name: "note.txt" }],
		},
	});
	expect(reopened.history(scope, task.id).at(-1)).toMatchObject({ title: input.title, body: "" });
	expect(reopened.requestResume(scope)).toBeDefined();
	expect(JSON.stringify(taskHook(reopened, { hook_event_name: "Stop", session_id: chat }))).toContain(
		"session_tasks_edit_notifications",
	);
	expect(reopened.acknowledgeEdit(scope, task.id, firstEdit.revision)).toBe(true);
	expect(reopened.acknowledgeEdit(scope, task.id, firstEdit.revision)).toBe(false);
	expect(reopened.nextEditNotification(scope)).toMatchObject({
		before: { revision: firstEdit.revision, body: firstEdit.body },
		after: { revision: secondEdit.revision, body: secondEdit.body },
	});
	expect(reopened.acknowledgeEdit(scope, task.id, secondEdit.revision)).toBe(true);
	expect(reopened.nextEditNotification(scope)).toBeNull();
	expect(reopened.pendingNotifications(scope)).toEqual({});
	expect(reopened.get(scope, task.id)).toEqual(done);
});

test("records user approval atomically when a blocked task is queued again", () => {
	const { service, scope } = harness();
	const task = service.create(scope, randomUUID(), taskInput.parse({ title: "Wait for approval" }), "agent");
	const { claimId } = service.claim({
		scope,
		taskId: task.id,
		expectedSerial: task.serial,
		assignee: "thread",
	});
	const receipt = "Waiting for your approval.";
	const blocked = service.settle({ scope, taskId: task.id, claimId, state: "blocked", receipt });
	const approval = "I authorize Codex to resume this task.\n\nUse the attached result.";
	const command = { scope, taskId: task.id, expectedSerial: blocked.serial };
	expect(() => service.requeue(command)).toThrow("invalid_state");
	const takenId = randomUUID();
	service.comment(scope, task.id, takenId, "An unrelated comment", "agent");
	expect(() => service.unblock(command, takenId, approval)).toThrow("conflict");
	expect(service.get(scope, task.id)).toEqual(blocked);
	expect(service.pendingNotifications(scope)).toEqual({});
	const commentId = randomUUID();
	const resumed = service.unblock(command, commentId, approval);
	expect(resumed.task).toMatchObject({ state: "queued", revision: task.revision, receipt: null });
	expect(resumed.wakeThreadId).toBeTruthy();
	expect(() => service.unblock(command, commentId, approval)).toThrow("conflict");
	expect(service.commentNotifications(scope)).toMatchObject([
		{ taskId: task.id, comment: { id: commentId, author: "user", body: approval } },
	]);
	expect(service.comments(scope, task.id).comments).toEqual(
		expect.arrayContaining([expect.objectContaining({ kind: "blocker", author: "agent", body: receipt })]),
	);
	expect(service.requestResume(scope)).toBeDefined();
	const unread = service.commentNotifications(scope)[0];
	if (!unread) throw new Error("missing approval notification");
	expect(service.acknowledgeComment(scope, unread.comment.ordinal)).toBe(true);
	const secondClaim = service.claim({ ...command, expectedSerial: resumed.task.serial, assignee: "thread" });
	const secondBlock = service.settle({
		scope,
		taskId: task.id,
		claimId: secondClaim.claimId,
		state: "blocked",
		receipt: "Waiting for a second confirmation.",
	});
	expect(() =>
		service.unblock({ ...command, expectedSerial: secondBlock.serial }, commentId, approval),
	).toThrow("conflict");
	expect(service.get(scope, task.id)).toEqual(secondBlock);
	expect(service.pendingNotifications(scope)).toEqual({});
});

test("adds generated titles without invalidating a claim or overwriting later manual edits", () => {
	const { service, scope } = harness();
	const otherScope = service.bind(randomUUID());
	const input = taskInput.parse({ title: "First line", body: "An instruction that stays current" });
	const task = service.createFromPanel(scope, randomUUID(), input).task;
	const claim = service.claim({ scope, taskId: task.id, expectedSerial: task.serial, assignee: "thread" });
	service.saveGeneratedTitle(otherScope, task.id, "Wrong board");
	expect(service.get(scope, task.id).title).toBe(input.title);
	service.saveGeneratedTitle(scope, task.id, "Generated summary");
	service.saveGeneratedTitle(scope, task.id, "Duplicate job");
	expect(service.list(scope).tasks[0]).toMatchObject({
		title: "Generated summary",
		serial: claim.task.serial,
	});
	expect(service.history(scope, task.id)[0]?.title).toBe(input.title);

	const originalEditor = { scope, taskId: task.id, expectedRevision: 1 };
	expect(service.edit(originalEditor, input, "user", { preserveTitle: true }).serial).toBe(claim.task.serial);
	expect(service.settle({ scope, taskId: task.id, claimId: claim.claimId, state: "queued" }).state).toBe(
		"queued",
	);
	const manual = service.createFromPanel(scope, randomUUID(), input).task;
	service.edit(
		{ scope, taskId: manual.id, expectedRevision: 1 },
		{ ...input, title: "Explicit title" },
		"user",
	);
	service.saveGeneratedTitle(scope, manual.id, "Late model output");
	expect(service.get(scope, manual.id).title).toBe("Explicit title");
	expect(service.history(scope, manual.id)[1]?.title).toBe(input.title);
});

test("splits a title-only instruction without losing its text, history or active claim", () => {
	const { service, scope } = harness();
	const original = "Vérifier la facture. Garde le montant exact, puis compare-le au reçu.";
	const input = taskInput.parse({ title: original, body: "  " });
	const task = service.createFromPanel(scope, randomUUID(), input).task;
	const claim = service.claim({ scope, taskId: task.id, expectedSerial: task.serial, assignee: "thread" });
	service.saveGeneratedTitle(scope, task.id, "Vérifier la facture", true);
	expect(service.get(scope, task.id)).toMatchObject({
		title: "Vérifier la facture",
		body: original,
		serial: claim.task.serial,
	});
	expect(service.history(scope, task.id)[0]).toMatchObject({ title: original, body: input.body });
	const unchanged = service.edit({ scope, taskId: task.id, expectedRevision: 1 }, input, "user", {
		preserveTitle: true,
		preserveBody: true,
	});
	expect(unchanged.serial).toBe(claim.task.serial);
	expect(service.settle({ scope, taskId: task.id, claimId: claim.claimId, state: "queued" }).state).toBe(
		"queued",
	);
	const command = { scope, taskId: task.id, expectedRevision: 1 };
	expect(() => service.edit(command, input, "user", { appendBody: "x".repeat(32768) })).toThrow(
		"invalid_context",
	);
	const appended = service.edit(command, input, "user", {
		preserveTitle: true,
		appendBody: "Capture jointe",
	});
	expect(appended).toMatchObject({
		title: "Vérifier la facture",
		body: `${original}\n\nCapture jointe`,
		revision: 2,
	});
});

test("keeps user revisions, code whitespace and exact attachment bytes after restart", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service, scope } = harness(path);
	const data = Buffer.from([0, 9, 42, 255]);
	const body = "if (ready) {\n\twork();\n}\n";
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({
			title: "Fix the alignment",
			body,
			files: [{ name: "capture.png", mime: "image/png", data: data.toString("base64") }],
		}),
		"user",
	);
	const attachment = task.attachments[0];
	if (!attachment) throw new Error("Expected uploaded file");
	const current = service.edit(
		{ scope, taskId: task.id, expectedRevision: task.revision },
		taskInput.parse({ title: "Align at 260px", body, mode: "thread", keep: [attachment.id] }),
		"user",
	);
	const reopened = harness(path).service;
	expect(reopened.history(scope, task.id).map((row) => [row.revision, row.title, row.body])).toEqual([
		[2, current.title, body],
		[1, task.title, body],
	]);
	expect(Buffer.from(reopened.file(scope, task.id, attachment.id).data)).toEqual(data);
	expect(reopened.get(scope, task.id).mode).toBe("thread");
});

test("a manual edit or cancellation invalidates a worker's old revision", () => {
	const { service, scope } = harness();
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Update the empty state" }),
		"agent",
	);
	const command = { scope, taskId: task.id, expectedSerial: task.serial };
	const current = service.claim({ ...command, assignee: "worker-1" });
	expect(() => service.claim({ ...command, assignee: "worker-2" })).toThrow("conflict");
	const changed = service.edit(
		{ ...command, expectedRevision: task.revision },
		taskInput.parse({ title: "Update in this chat", mode: "thread" }),
		"user",
	);
	expect(() =>
		service.settle({ ...command, claimId: current.claimId, state: "done", receipt: "Old check passed" }),
	).toThrow("conflict");
	expect(() => service.claim({ ...command, expectedSerial: changed.serial, assignee: "worker-1" })).toThrow(
		"invalid_state",
	);
	const own = service.claim({ ...command, expectedSerial: changed.serial, assignee: "thread" });
	const cancelled = service.cancel({ ...command, expectedSerial: own.task.serial });
	expect(service.list(scope).tasks).toHaveLength(0);
	expect(service.list(scope, 0, true).tasks[0]?.revision).toBe(2);
	expect(() =>
		service.settle({ ...command, claimId: own.claimId, state: "done", receipt: "Old check passed" }),
	).toThrow("conflict");
	expect(service.requeue({ ...command, expectedSerial: cancelled.serial }).state).toBe("queued");
});

test("scopes list, read and mutations to the originating chat and deduplicates create", () => {
	const { service, scope } = harness();
	const foreignScope = service.bind(randomUUID());
	const actionId = randomUUID();
	const input = taskInput.parse({ title: "Inspect the scrollbar" });
	const first = service.create(scope, actionId, input, "user");
	expect(service.create(scope, actionId, input, "user")).toEqual(first);
	expect(service.list(scope).tasks).toHaveLength(1);
	expect(service.list(foreignScope).tasks).toHaveLength(0);
	expect(() => service.history(foreignScope, first.id)).toThrow("not_found");
	expect(() =>
		service.cancel({ scope: foreignScope, taskId: first.id, expectedSerial: first.serial }),
	).toThrow("not_found");
});

test("SQL rejects impossible state and a revision without its parent", () => {
	const { database, service, scope } = harness();
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Check invariant enforcement" }),
		"agent",
	);
	expect(() => database.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id)).toThrow(
		/CHECK constraint/,
	);
	expect(() =>
		database.prepare("INSERT INTO task_revision VALUES (?,1,'Task','','auto','user',0)").run(randomUUID()),
	).toThrow(/FOREIGN KEY/);
});

test("recovers an abandoned claim only by explicit user request", () => {
	const { service, scope } = harness();
	const task = service.create(scope, randomUUID(), taskInput.parse({ title: "Check recovery" }), "user");
	const claimed = service.claim({
		scope,
		taskId: task.id,
		expectedSerial: task.serial,
		assignee: "subagent",
	});
	expect(service.list(scope).counts.running).toBe(1);
	const released = service.requeue({ scope, taskId: task.id, expectedSerial: claimed.task.serial });
	expect(released.state).toBe("queued");
	expect(() =>
		service.settle({
			scope,
			taskId: task.id,
			claimId: claimed.claimId,
			state: "done",
			receipt: "Late result",
		}),
	).toThrow("conflict");
});

test("requires a complete verification and can uncheck a completed task", () => {
	const { service, scope } = harness();
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Verify the operation" }),
		"user",
	);
	const command = { scope, taskId: task.id };
	const claim = service.claim({ ...command, expectedSerial: task.serial, assignee: "thread" });
	const settle = { ...command, claimId: claim.claimId, state: "done" as const };
	const verification = {
		work: "Created a task and claimed it in SQLite",
		check: "Read the scoped queue after the claim",
		result: "The exact task has state running",
		evidence: "The scoped task and claim returned by the SQLite test",
	};
	expect(() => service.settle({ ...settle, receipt: "Done" })).toThrow("verification_required");
	expect(() => service.settle({ ...settle, verification: { ...verification, evidence: " " } })).toThrow(
		"verification_required",
	);
	expect(service.list(scope).counts.done).toBe(0);
	const done = service.settle({ ...settle, verification });
	expect(service.get(scope, task.id).verification).toEqual(verification);
	expect(service.list(scope).counts.done).toBe(1);
	const observation = "The displayed task and evidence match the executed check.";
	const approved = service.validate({ ...command, expectedSerial: done.serial }, observation);
	expect(approved).toMatchObject({ state: "done", verification, manualValidation: observation });
	expect(service.get(scope, task.id).manualValidation).toBe(observation);
	expect(service.list(scope).counts.done).toBe(1);
	expect(() => service.validate({ ...command, expectedSerial: approved.serial }, observation)).toThrow(
		"invalid_state",
	);
	const reopened = service.requeue({ ...command, expectedSerial: approved.serial });
	expect(reopened).toMatchObject({ state: "queued", receipt: null, revision: task.revision });
	expect(reopened.verification).toBeUndefined();
	expect(reopened.manualValidation).toBeUndefined();
	expect(service.list(scope).counts.done).toBe(0);
	expect(() => service.settle({ ...settle, verification })).toThrow("conflict");
});

test("records a human check against the current task and preserves the blocker on completion", () => {
	const { service, scope } = harness();
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Inspect the icon in Codex" }),
		"user",
	);
	const target = { scope, taskId: task.id, expectedSerial: task.serial };
	const claimed = service.claim({ ...target, assignee: "thread" });
	expect(() => service.validate({ ...target, expectedSerial: claimed.task.serial }, "I checked it")).toThrow(
		"invalid_state",
	);
	const blocked = service.settle({
		...target,
		claimId: claimed.claimId,
		state: "blocked",
		receipt: "Waiting for visual review",
	});
	expect(service.list(scope, 0, "blocked").tasks.map(({ id }) => id)).toEqual([task.id]);
	const other = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Other remaining task" }),
		"user",
	);
	expect(service.list(scope, 0, ["remaining"]).tasks.map(({ id }) => id)).toEqual([other.id]);
	expect(service.list(scope, 0, ["remaining", "blocked"]).tasks.map(({ id }) => id)).toEqual([
		task.id,
		other.id,
	]);
	expect(service.list(scope, 0, ["done", "blocked"]).tasks.map(({ id }) => id)).toEqual([task.id]);
	expect(() => service.validate(target, "I checked it")).toThrow("conflict");
	expect(() => service.validate({ ...target, expectedSerial: blocked.serial }, " ")).toThrow(
		"verification_required",
	);
	const observed = "I opened the panel and saw the new turquoise checklist icon.";
	const done = service.validate({ ...target, expectedSerial: blocked.serial }, observed);
	expect(done).toMatchObject({ state: "done", manualValidation: observed, revision: task.revision });
	expect(service.list(scope, 0, "remaining").tasks.map(({ id }) => id)).toEqual([other.id]);
	expect(service.list(scope, 0, "done").tasks.map(({ id }) => id)).toEqual([task.id]);
	expect(service.comments(scope, task.id).comments).toMatchObject([
		{ author: "agent", kind: "blocker", body: blocked.receipt },
	]);
});

test("keeps attributed, scoped comments independent of task status and revisions", () => {
	const { service, scope } = harness();
	const other = service.bind(randomUUID());
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Keep a conversation on this task" }),
		"user",
	);
	const clientId = randomUUID();
	const first = service.comment(scope, task.id, clientId, "I will verify it at 320 px.", "user");
	expect(service.comment(scope, task.id, clientId, first.body, "user")).toEqual(first);
	expect(() => service.comment(scope, task.id, clientId, "Changed", "agent")).toThrow("conflict");
	expect(() => service.comments(other, task.id)).toThrow("not_found");
	expect(() => service.comment(other, task.id, randomUUID(), "Unrelated", "agent")).toThrow("not_found");
	const second = service.comment(scope, task.id, randomUUID(), "The panel is ready to test.", "agent");
	expect(service.comments(scope, task.id).comments).toEqual([first, second]);
	expect(service.get(scope, task.id)).toEqual(task);
	service.cancel({ scope, taskId: task.id, expectedSerial: task.serial });
	expect(service.list(scope, 0, "all").tasks.map(({ id }) => id)).toEqual([task.id]);
	expect(service.list(scope).tasks).toHaveLength(0);
	expect(service.comments(scope, task.id).comments).toEqual([first, second]);
});

test("persists queued drag order across restart and keeps task identities, other states and boards intact", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-task-order-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service, scope, database } = harness(path);
	const otherScope = service.bind(randomUUID());
	const add = (label: string, board = scope) =>
		service.create(board, randomUUID(), taskInput.parse({ title: label }), "user");
	const first = add("First");
	const done = add("Done");
	service.validate({ scope, taskId: done.id, expectedSerial: done.serial }, "Checked the fixture.");
	const second = add("Second");
	const third = add("Third");
	const foreign = add("Other board", otherScope);
	expect(() =>
		database
			.prepare("INSERT INTO task_order (scope,task_ordinal,position) VALUES (?,?,?)")
			.run(scope, first.ordinal, foreign.ordinal),
	).toThrow(/foreign key/i);
	const down = {
		scope,
		taskId: first.id,
		targetId: third.id,
		position: first.ordinal,
		targetPosition: third.ordinal,
	};
	service.moveQueued(down);
	expect(service.list(scope).tasks.map(({ id }) => id)).toEqual([second.id, done.id, third.id, first.id]);
	expect(service.list(scope, done.ordinal).tasks.map(({ id }) => id)).toEqual([third.id, first.id]);
	expect(service.get(scope, first.id)).toEqual(first);
	expect(() => service.moveQueued(down)).toThrow("conflict");
	expect(() =>
		service.moveQueued({ ...down, targetId: foreign.id, targetPosition: foreign.ordinal }),
	).toThrow("conflict");
	expect(() =>
		service.moveQueued({ ...down, position: third.ordinal, targetId: done.id, targetPosition: done.ordinal }),
	).toThrow("conflict");

	const restarted = harness(path).service;
	expect(restarted.list(scope).tasks.map(({ id }) => id)).toEqual([second.id, done.id, third.id, first.id]);
	expect(restarted.list(otherScope).tasks.map(({ id }) => id)).toEqual([foreign.id]);
	restarted.moveQueued({
		scope,
		taskId: first.id,
		targetId: second.id,
		position: third.ordinal,
		targetPosition: first.ordinal,
	});
	expect(restarted.list(scope).tasks.map(({ id }) => id)).toEqual([first.id, done.id, second.id, third.id]);
});

test("shows a generated title and Markdown for the current revision while retaining the input and claim", () => {
	const { service, scope } = harness();
	const input = taskInput.parse({ title: "Verify report", body: "  const expected = 1;\n" });
	const task = service.create(scope, randomUUID(), input, "user");
	const generated = {
		title: "Verify the report",
		body: "**Check** the comparison.\n\n```js\n  const expected = 1;\n```",
	};
	const { task: running } = service.claim({
		scope,
		taskId: task.id,
		expectedSerial: task.serial,
		assignee: "thread",
	});
	service.saveReformulation(scope, task.id, task.revision, generated);
	expect(service.get(scope, task.id)).toEqual(running);
	expect(service.readReformulation(running)).toEqual(generated);
	expect(service.list(scope, 0, false, true).tasks[0]?.title).toBe(generated.title);
	expect(service.list(scope).tasks[0]?.title).toBe(input.title);
	expect(service.history(scope, task.id)[0]?.body).toBe(input.body);
	const revised = service.edit(
		{ scope, taskId: task.id, expectedRevision: task.revision },
		{ ...input, body: "The actual next instruction" },
		"user",
	);
	service.saveReformulation(scope, task.id, task.revision, { ...generated, title: "Stale suggestion" });
	expect(service.readReformulation(revised)).toBeUndefined();
	expect(service.list(scope, 0, false, true).tasks[0]?.title).toBe(input.title);
	service.saveReformulation(scope, task.id, revised.revision, generated);
	expect(service.readReformulation(revised)).toEqual(generated);
});

test("keeps recurring instructions scoped and requests them on every prompt without making them tasks", () => {
	const { service, scope } = harness();
	const thread = randomUUID();
	const another = service.bind(thread);
	const prompt = { hook_event_name: "UserPromptSubmit", session_id: thread, prompt: "Bonjour" };
	expect(JSON.stringify(taskHook(service, prompt))).not.toContain("Read session_tasks_instructions");
	const body = "- Run the tests after a change.\n- Report the result.";
	expect(service.saveInstructions(another, { chat: { revision: 0, body } }).chat).toEqual({
		revision: 1,
		body,
	});
	expect(service.readInstructions(scope).chat).toEqual({ revision: 0, body: "" });
	expect(service.list(another).tasks).toEqual([]);
	expect(() => service.saveInstructions(another, { chat: { revision: 0, body: "Outdated change" } })).toThrow(
		"conflict",
	);

	for (const request of [prompt, { ...prompt, prompt: "Nouvelle demande" }]) {
		const context = JSON.stringify(taskHook(service, request));
		expect(context).toContain("Read session_tasks_instructions");
		expect(context).toContain("Follow the order returned by session_tasks_list");
		expect(context).not.toContain("Run the tests after a change");
	}
	expect(taskHook(service, { ...prompt, hook_event_name: "Stop" })).toEqual({});
	expect(service.saveInstructions(another, { chat: { revision: 1, body: " " } }).chat).toEqual({
		revision: 2,
		body: "",
	});
	expect(JSON.stringify(taskHook(service, prompt))).toContain("Discard each-turn instruction lists");
	const permanent = { revision: 0, body: "- Summarize verification." };
	service.saveInstructions(scope, { permanent });
	expect(service.readInstructions(another).permanent).toEqual({ ...permanent, revision: 1 });
	expect(JSON.stringify(taskHook(service, prompt))).toContain("Read session_tasks_instructions");
	expect(() =>
		service.saveInstructions(another, { chat: { revision: 2, body }, permanent: { ...permanent, body: "" } }),
	).toThrow("conflict");
	expect(service.readInstructions(another).chat).toEqual({ revision: 2, body: "" });
});

test("keeps reformulation through metadata edits, even if generation completes after the edit", () => {
	const { service, scope } = harness();
	const input = taskInput.parse({ title: "Inspect report", body: "Keep the original scope." });
	const task = service.create(scope, randomUUID(), input, "user");
	const generated = { title: "Inspect the report", body: "**Inspect** the original scope." };
	const changeMode = (revision: number, mode: "thread" | "auto") =>
		service.edit({ scope, taskId: task.id, expectedRevision: revision }, { ...input, mode }, "user");
	const during = changeMode(task.revision, "thread");
	service.saveReformulation(scope, task.id, task.revision, generated);
	expect(service.readReformulation(during)).toEqual(generated);
	const after = changeMode(during.revision, "auto");
	expect(service.readReformulation(after)).toEqual(generated);
	expect(service.get(scope, task.id).body).toBe(input.body);
});

test("lists individual instructions including legacy text, and isolates changes to the selected scope", () => {
	const { service, scope } = harness();
	const otherThread = randomUUID();
	const other = service.bind(otherThread);
	const chatText = "## Existing notes\n\n  Keep formatting.\n";
	service.saveInstructions(scope, { chat: { revision: 0, body: chatText } });
	const entryId = randomUUID();
	const first = { entryId, expectedRevision: 0, body: "**Verify** each change.", permanent: false };
	service.saveInstructionEntry(scope, first);
	service.saveInstructionEntry(scope, first);
	expect(service.listInstructionEntries(scope)).toEqual([
		{ id: "chat", revision: 1, body: chatText, permanent: false },
		{ id: entryId, revision: 1, body: first.body, permanent: false },
	]);
	expect(service.listInstructionEntries(other)).toEqual([]);
	expect(() =>
		service.saveInstructionEntry(other, { ...first, expectedRevision: 1, permanent: true }),
	).toThrow("conflict");
	service.saveInstructionEntry(scope, { ...first, expectedRevision: 1, permanent: true });
	expect(service.listInstructionEntries(other)).toEqual([
		{ id: entryId, revision: 2, body: first.body, permanent: true },
	]);
	const hook = { hook_event_name: "UserPromptSubmit", session_id: otherThread };
	expect(JSON.stringify(taskHook(service, hook))).toContain("Read session_tasks_instructions");
	expect(() => service.removeInstructionEntry(other, entryId, 1)).toThrow("conflict");
	service.removeInstructionEntry(scope, entryId, 2);
	expect(() => service.saveInstructionEntry(scope, first)).toThrow("conflict");
	expect(() =>
		service.saveInstructionEntry(other, { ...first, expectedRevision: 2, permanent: true }),
	).toThrow("conflict");
	expect(JSON.stringify(taskHook(service, hook))).toContain("Discard each-turn instruction lists");
	service.saveInstructionEntry(scope, {
		entryId: "chat",
		expectedRevision: 1,
		body: chatText,
		permanent: true,
	});
	expect(service.readInstructions(scope).chat).toEqual({ revision: 2, body: "" });
	expect(service.listInstructionEntries(other)[0]).toMatchObject({ body: chatText, permanent: true });
});

test("applies original instructions and only displays the current, scoped reformulation", () => {
	const { service, scope } = harness();
	const other = service.bind(randomUUID());
	const entryId = randomUUID();
	const original = "Toujours garder les passages en code.\r\nSauf si le fichier est vide.";
	const first = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: 0,
		body: original,
		permanent: false,
	});
	const presented = {
		title: "Préserver le code",
		body: "**Préserver** le code, sauf pour les fichiers vides.",
	};
	service.saveInstructionReformulation(other, entryId, first.revision, presented);
	expect(service.listInstructionEntries(scope, true)[0]?.reformulation).toBeUndefined();
	service.saveInstructionReformulation(scope, entryId, first.revision, presented);
	expect(service.listInstructionEntries(scope, true)[0]?.reformulation).toEqual(presented);
	expect(service.listInstructionEntries(scope)[0]).toEqual(first);
	const moved = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: 1,
		body: original,
		permanent: true,
	});
	expect(moved.reformulation).toEqual(presented);
	expect(service.listInstructionEntries(other, true)[0]?.reformulation).toEqual(presented);
	const edited = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: 2,
		body: "Vérifier la facture.",
		permanent: true,
	});
	expect(service.listInstructionEntries(other, true)[0]?.reformulation).toBeUndefined();
	service.saveInstructionReformulation(scope, entryId, first.revision, presented);
	expect(service.listInstructionEntries(scope, true)[0]?.reformulation).toBeUndefined();
	service.saveInstructionReformulation(scope, entryId, edited.revision, {
		title: "Facture",
		body: "- Vérifier la facture.",
	});
	expect(service.listInstructionEntries(other, true)[0]?.reformulation?.title).toBe("Facture");
	service.removeInstructionEntry(scope, entryId, edited.revision);
	service.saveInstructionReformulation(scope, entryId, edited.revision, presented);
	expect(service.listInstructionEntries(other, true)).toEqual([]);
});

test("replaces edited instruction targets atomically without detaching another chat", () => {
	const { service, scope } = harness();
	const other = service.bind(randomUUID());
	const unrelated = service.bind(randomUUID());
	const entryId = randomUUID();
	const global = { kind: "global" } as const;
	const chat = { kind: "chat" } as const;
	const source = { entryId, expectedRevision: 0, body: "Preserve this instruction.", permanent: false };
	const first = service.saveInstructionEntry(scope, { ...source, targets: [chat] });
	service.setInstructionBindings(other, entryId, first.revision, [chat], true);
	const move = { ...source, expectedRevision: first.revision, targets: [global], replaceTargetsFrom: [chat] };
	const changed = service.saveInstructionEntry(scope, move);
	expect(changed.bindings).toEqual([{ kind: "other_chat" }, global]);
	expect(service.listInstructionEntries(unrelated).map((entry) => entry.id)).toContain(entryId);
	expect(() => service.saveInstructionEntry(scope, move)).toThrow("conflict");
	const local = service.saveInstructionEntry(scope, {
		...move,
		expectedRevision: changed.revision,
		targets: [chat],
		replaceTargetsFrom: [global],
	});
	expect(local.bindings).toContainEqual(chat);
	expect(local.bindings).toContainEqual({ kind: "other_chat" });
	expect(service.listInstructionEntries(other).map((entry) => entry.id)).toContain(entryId);
	expect(service.listInstructionEntries(unrelated).map((entry) => entry.id)).not.toContain(entryId);
	service.setInstructionBindings(scope, entryId, local.revision, [global], true);
	expect(() =>
		service.saveInstructionEntry(scope, {
			...move,
			expectedRevision: local.revision,
			targets: [global],
			replaceTargetsFrom: [chat],
		}),
	).toThrow("conflict");
});

test("does not revive an older optimization when editing the scope of new instruction text", () => {
	const { service, scope } = harness();
	const entryId = randomUUID();
	const chat = { kind: "chat" } as const;
	const global = { kind: "global" } as const;
	const first = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: 0,
		body: "Old instructions.",
		permanent: false,
		targets: [chat],
	});
	service.saveInstructionReformulation(scope, entryId, first.revision, {
		title: "Old title",
		body: "Old formatted version.",
	});
	const changed = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: first.revision,
		body: "New instructions.",
		permanent: false,
		targets: [],
	});
	const moved = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: changed.revision,
		body: changed.body,
		permanent: false,
		targets: [global],
		replaceTargetsFrom: [chat],
	});
	expect(moved.body).toBe("New instructions.");
	expect(moved.reformulation).toBeUndefined();
});

test("allows replacing a scope assembled from several batches of project bindings", () => {
	const previous = Array.from({ length: MAX_INSTRUCTION_TARGETS + 1 }, () => ({
		kind: "project" as const,
		projectId: randomUUID(),
	}));
	const write = {
		entryId: randomUUID(),
		expectedRevision: 1,
		body: "Preserve this instruction.",
		permanent: false,
		replaceTargetsFrom: previous,
	};
	expect(instructionEntryWrite.safeParse({ ...write, targets: [{ kind: "chat" }] }).success).toBe(true);
	expect(instructionEntryWrite.safeParse({ ...write, targets: previous }).success).toBe(false);
});

test("keeps Markdown wrappers around an instruction at the source byte limit", () => {
	const { service, scope } = harness();
	const entryId = randomUUID();
	const source = "x".repeat(4096);
	const saved = service.saveInstructionEntry(scope, {
		entryId,
		expectedRevision: 0,
		body: source,
		permanent: false,
	});
	const result = { title: "Exemple complet", body: `\`\`\`text\n${source}\n\`\`\`` };
	service.saveInstructionReformulation(scope, entryId, saved.revision, result);
	expect(service.listInstructionEntries(scope, true)[0]?.reformulation).toEqual(result);
	expect(service.listInstructionEntries(scope)[0]?.body).toBe(source);
});

test("migrates old instructions and resolves project membership from the local Codex state", () => {
	const directory = mkdtempSync(join(tmpdir(), "session-tasks-project-"));
	resources.push(() => rmSync(directory, { recursive: true, force: true }));
	const statePath = join(directory, "state.sqlite");
	const state = new DatabaseSync(statePath);
	resources.push(() => state.close());
	state.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER);
		CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));`);
	const projectId = randomUUID();
	const thread = randomUUID();
	state.prepare("INSERT INTO projects VALUES(?, ?, 0)").run(projectId, "Project");
	state.prepare("INSERT INTO threads VALUES(?, ?)").run(thread, projectId);
	const projects = localCodexProjects(statePath);
	expect(projects.list()).toEqual([{ id: projectId, name: "Project", chatCount: 1 }]);
	expect(projects.forThread(thread)).toBe(projectId);
	expect(projects.forThread(randomUUID())).toBeUndefined();

	const taskPath = join(directory, "tasks.sqlite");
	const legacy = new DatabaseSync(taskPath);
	legacy.exec(SCHEMA);
	const scope = randomUUID();
	const entryId = randomUUID();
	legacy.prepare("INSERT INTO board VALUES(?, ?)").run(thread, scope);
	legacy
		.prepare("INSERT INTO instruction_entry(id,scope,revision,body) VALUES(?, ?, 1, ?)")
		.run(entryId, scope, "Legacy");
	legacy.close();
	const { database } = harness(taskPath);
	const service = new TaskService(new TaskRepository(database), Date.now, projects);
	expect(service.listInstructionEntries(scope)).toEqual([
		{ id: entryId, revision: 1, body: "Legacy", permanent: false },
	]);
	expect(() =>
		database.prepare("UPDATE instruction_entry SET project_id=? WHERE id=?").run(projectId, entryId),
	).toThrow();
	expect(database.prepare("PRAGMA index_list(instruction_entry)").all()).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "instruction_entry_project" })]),
	);
});

test("applies a project instruction only to current members, including after a chat moves", () => {
	const { database } = harness();
	const projectId = randomUUID();
	const secondProject = randomUUID();
	const editor = randomUUID();
	const firstChat = randomUUID();
	const secondChat = randomUUID();
	const elsewhere = randomUUID();
	const memberships = new Map<string, string>([
		[firstChat, projectId],
		[secondChat, projectId],
		[elsewhere, secondProject],
	]);
	const service = new TaskService(new TaskRepository(database), Date.now, {
		list: () => [
			{ id: projectId, name: "First project" },
			{ id: secondProject, name: "Second project" },
		],
		forThread: (thread) => memberships.get(thread),
	});
	const owner = service.bind(editor);
	const first = service.bind(firstChat);
	const second = service.bind(secondChat);
	const other = service.bind(elsewhere);
	const entryId = randomUUID();
	const body = "Verify the invoices for this project.";
	const command = { entryId, body, expectedRevision: 0, permanent: false, projectId };
	expect(() =>
		service.saveInstructionEntry(owner, { ...command, projectId: randomUUID() }, true, true),
	).toThrow("invalid_context");
	expect(() => service.saveInstructionEntry(owner, { ...command, permanent: true }, true, true)).toThrow(
		"invalid_context",
	);
	service.saveInstructionEntry(owner, command, true, true);
	service.saveInstructionReformulation(owner, entryId, 1, { title: "Verify invoices", body: "Formatted" });
	expect(service.listInstructionEntries(owner, true, true)[0]?.reformulation?.title).toBe("Verify invoices");
	expect(service.listInstructionEntries(first)).toEqual([
		{ id: entryId, body, revision: 1, permanent: false, projectId },
	]);
	expect(service.listInstructionEntries(second)[0]?.body).toBe(body);
	expect(service.listInstructionEntries(owner)).toEqual([]);
	expect(service.listInstructionEntries(other)).toEqual([]);
	const hook = (session_id: string) =>
		JSON.stringify(taskHook(service, { hook_event_name: "UserPromptSubmit", session_id }));
	expect(hook(firstChat)).toContain("Read session_tasks_instructions");
	expect(hook(elsewhere)).not.toContain("Read session_tasks_instructions");
	memberships.set(firstChat, secondProject);
	expect(service.listInstructionEntries(first)).toEqual([]);
	expect(hook(firstChat)).not.toContain("Read session_tasks_instructions");
	service.saveInstructionEntry(
		owner,
		{ ...command, expectedRevision: 1, projectId: secondProject },
		true,
		true,
	);
	expect(service.listInstructionEntries(second)).toEqual([]);
	expect(service.listInstructionEntries(other)[0]?.body).toBe(body);
	service.removeInstructionEntry(owner, entryId, 2, true);
	expect(service.listInstructionEntries(other)).toEqual([]);
});

test("filters instructions by lifecycle event and allows one finish pass per turn", () => {
	const { service, scope } = harness();
	const thread = randomUUID();
	const sessionScope = service.bind(thread);
	const hook = (name: string, fields?: object) =>
		taskHook(service, { hook_event_name: name, session_id: thread, ...fields });
	const regular = { entryId: randomUUID(), expectedRevision: 0, body: "Default behavior.", permanent: false };
	const timed = { ...regular, entryId: randomUUID(), body: "Check readiness and clean this build." };
	service.saveInstructionEntry(sessionScope, regular);
	service.saveInstructionEntry(sessionScope, { ...timed, moments: ["start", "finish"] });
	const ids = (moment: "start" | "turn" | "finish", board = sessionScope) =>
		service.listInstructionEntries(board, false, false, moment).map(({ id }) => id);
	expect(ids("turn")).toEqual([regular.entryId]);
	expect(ids("start")).toEqual([timed.entryId]);
	expect(ids("finish")).toEqual([timed.entryId]);
	expect(ids("finish", scope)).toEqual([]);
	expect(JSON.stringify(hook("SessionStart", { source: "startup" }))).toContain('moment=\\"start\\"');
	expect(JSON.stringify(hook("SessionStart", { source: "resume" }))).not.toContain(timed.body);
	expect(hook("SessionStart", { source: "compact" })).toEqual({});
	expect(hook("Stop")).toMatchObject({
		decision: "block",
		reason: expect.stringContaining('moment="finish"'),
	});
	expect(hook("Stop", { stop_hook_active: true })).toEqual({});
	const firstTurn = randomUUID();
	const nextTurn = randomUUID();
	hook("UserPromptSubmit", { turn_id: firstTurn });
	expect(hook("Stop", { turn_id: firstTurn })).toMatchObject({ decision: "block" });
	hook("UserPromptSubmit", { turn_id: firstTurn, prompt: "Follow-up in the same turn." });
	expect(hook("Stop", { turn_id: firstTurn, stop_hook_active: true })).toEqual({});
	expect(hook("Stop", { turn_id: nextTurn })).toMatchObject({ decision: "block" });
	hook("UserPromptSubmit");
	expect(hook("Stop")).toMatchObject({ decision: "block" });
	service.saveInstructionEntry(sessionScope, { ...timed, expectedRevision: 1, moments: ["turn"] });
	expect(ids("turn")).toEqual([regular.entryId, timed.entryId]);
	expect(ids("finish")).toEqual([]);
	hook("UserPromptSubmit");
	expect(hook("Stop")).toEqual({});
	expect(instructionEntryWrite.safeParse({ ...timed, moments: [] }).success).toBe(false);
});

test("applies an exclusion scope at prompt time and after editing or adding projects", () => {
	const fixture = mkdtempSync(join(tmpdir(), "session-task-project-exclusions-"));
	resources.push(() => rmSync(fixture, { recursive: true, force: true }));
	const statePath = join(fixture, "state_5.sqlite");
	const state = new DatabaseSync(statePath);
	resources.push(() => state.close());
	state.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER);
		CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));`);
	const [included, excluded, future] = [randomUUID(), randomUUID(), randomUUID()];
	const [owner, includedChat, excludedChat, futureChat] = [
		randomUUID(),
		randomUUID(),
		randomUUID(),
		randomUUID(),
	];
	const addProject = state.prepare("INSERT INTO projects VALUES(?, ?, ?)");
	const addThread = state.prepare("INSERT INTO threads VALUES(?, ?)");
	addProject.run(included, "Included project", 0);
	addProject.run(excluded, "Excluded project", 1);
	addThread.run(owner, null);
	addThread.run(includedChat, included);
	addThread.run(excludedChat, excluded);
	const { database } = harness(join(fixture, "tasks.sqlite3"));
	const service = new TaskService(new TaskRepository(database), Date.now, localCodexProjects(statePath));
	const scope = service.bind(owner);
	const entryId = randomUUID();
	const saved = { entryId, body: "Check the real surface.", permanent: false };
	const except = (projectIds: string[]) => ({ kind: "projects_except" as const, projectIds });
	expect(() =>
		service.saveInstructionEntry(
			scope,
			{
				...saved,
				expectedRevision: 0,
				targets: [except([included, excluded])],
			},
			true,
			true,
		),
	).toThrow("invalid_context");
	service.saveInstructionEntry(
		scope,
		{ ...saved, expectedRevision: 0, targets: [except([excluded])] },
		true,
		true,
	);
	expect(service.listInstructionLibrary(scope)[0]?.bindings).toEqual([except([excluded])]);
	const read = (thread: string) => service.listInstructionEntries(service.bind(thread)).map(({ id }) => id);
	const prompt = (thread: string) =>
		JSON.stringify(taskHook(service, { hook_event_name: "UserPromptSubmit", session_id: thread }));
	expect(read(includedChat)).toEqual([entryId]);
	expect(prompt(includedChat)).toContain("Read session_tasks_instructions");
	expect(read(excludedChat)).toEqual([]);
	expect(prompt(excludedChat)).toContain("There are no active Session Tasks instructions");
	expect(read(owner)).toEqual([]);
	addProject.run(future, "New project", 2);
	addThread.run(futureChat, future);
	expect(read(futureChat)).toEqual([entryId]);
	expect(() => service.deleteUnboundInstruction(scope, entryId, 1)).toThrow("conflict");
	service.saveInstructionEntry(
		scope,
		{
			...saved,
			expectedRevision: 1,
			targets: [except([included])],
			replaceTargetsFrom: [except([excluded])],
		},
		true,
		true,
	);
	expect(read(includedChat)).toEqual([]);
	expect(read(excludedChat)).toEqual([entryId]);
	expect(service.listInstructionLibrary(scope)[0]?.bindings).toEqual([except([included])]);
	expect(() => service.setInstructionBindings(scope, entryId, 2, [{ kind: "global" }], true)).toThrow(
		"conflict",
	);
	expect(() =>
		database.prepare("INSERT INTO instruction_project_exclusion VALUES(?,?)").run(entryId, "x".repeat(36)),
	).toThrow("CHECK constraint failed");
	state.prepare("UPDATE threads SET project_id=NULL WHERE project_id=?").run(included);
	state.prepare("DELETE FROM projects WHERE id=?").run(included);
	const detached = service.setInstructionBindings(scope, entryId, 2, [except([included])], false);
	expect(read(excludedChat)).toEqual([]);
	service.saveInstructionReformulation(
		scope,
		entryId,
		2,
		{ title: "Check the surface", body: saved.body },
		true,
	);
	const restored = service.setInstructionBindings(
		scope,
		entryId,
		detached.revision,
		[except([included])],
		true,
	);
	expect(service.listInstructionLibrary(scope)[0]?.bindings).toEqual([except([included])]);
	expect(service.listInstructionLibrary(scope)[0]?.reformulation?.title).toBe("Check the surface");
	service.saveInstructionEntry(
		scope,
		{
			...saved,
			expectedRevision: restored.revision,
			targets: [except([])],
			replaceTargetsFrom: [except([included])],
		},
		true,
		true,
	);
	expect(read(includedChat)).toEqual([]);
	expect(read(excludedChat)).toEqual([entryId]);
	expect(read(owner)).toEqual([]);
});

test("keeps a repurposed global instruction project-scoped when a legacy client writes again", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-task-migrate-exclusions-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const old = new DatabaseSync(path);
	old.exec(SCHEMA);
	old.prepare("INSERT INTO permanent_instructions VALUES(1,?,?)").run(4, "Original global instruction");
	old.close();
	const { database } = harness(path);
	const [included, excluded, excludedThread] = [randomUUID(), randomUUID(), randomUUID()];
	const service = new TaskService(new TaskRepository(database), Date.now, {
		list: () => [
			{ id: included, name: "Included" },
			{ id: excluded, name: "Excluded" },
		],
		forThread: (thread) => (thread === excludedThread ? excluded : included),
	});
	const scope = service.bind(randomUUID());
	const excludedScope = service.bind(excludedThread);
	const entry = service.listInstructionLibrary(scope)[0];
	if (!entry) throw new Error("Missing migrated instruction");
	expect(entry?.bindings).toEqual([{ kind: "global" }]);
	service.saveInstructionEntry(
		scope,
		{
			entryId: entry.id,
			expectedRevision: entry.revision,
			body: entry.body,
			permanent: false,
			targets: [{ kind: "projects_except", projectIds: [excluded] }],
			replaceTargetsFrom: [{ kind: "global" }],
		},
		true,
		true,
	);
	const legacy = service.readInstructions(scope).permanent;
	expect(legacy.body).toEqual("");
	service.saveInstructions(scope, { permanent: { ...legacy, body: "New global instruction" } });
	expect(service.listInstructionEntries(excludedScope).map(({ body }) => body)).toEqual([
		"New global instruction",
	]);
	expect(service.listInstructionEntries(scope).map(({ body }) => body)).toEqual([
		"New global instruction",
		"Original global instruction",
	]);
});

test("keeps comment files attached to their comment through retries and restart", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-task-comment-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service, scope } = harness(path);
	const foreign = service.bind(randomUUID());
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Comment with context" }),
		"user",
	);
	const file = { name: "notes.md", mime: "text/markdown", data: Buffer.from("**Notes**").toString("base64") };
	const commentId = randomUUID();
	const result = service.comment(scope, task.id, commentId, "", "user", [file]);
	expect(result.body).toBe("");
	const attachmentId = result.attachments?.[0]?.id;
	if (!attachmentId) throw new Error("missing comment attachment");
	expect(service.comment(scope, task.id, commentId, "", "user", [file])).toEqual(result);
	expect(() => service.comment(scope, task.id, commentId, "", "user", [{ ...file, data: "eA==" }])).toThrow(
		"conflict",
	);
	expect(() => service.comment(foreign, task.id, randomUUID(), "", "user", [file])).toThrow("not_found");
	expect(() => service.file(foreign, task.id, attachmentId)).toThrow("not_found");
	expect(service.get(scope, task.id)).toEqual(task);
	const reopened = harness(path).service;
	expect(reopened.comments(scope, task.id).comments).toEqual([result]);
	expect(Buffer.from(reopened.file(scope, task.id, attachmentId).data).toString("base64")).toBe(file.data);
});

test("replaces a comment with its reformulation while accepting a retry of the original submission", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-comment-format-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service, scope, database } = harness(path);
	const task = service.create(
		scope,
		randomUUID(),
		taskInput.parse({ title: "Keep the source comment" }),
		"user",
	);
	const id = randomUUID();
	const original = "j'ai lance npm test, ok [preuve](https://example.test/passed)";
	const formatted = "J’ai lancé `npm test` avec succès. [Preuve](https://example.test/passed)";
	service.comment(scope, task.id, id, original, "user");
	const foreign = service.bind(randomUUID());
	expect(() => service.saveCommentReformulation(foreign, task.id, id, formatted)).toThrow("not_found");
	service.saveCommentReformulation(scope, task.id, id, "");
	service.saveCommentReformulation(scope, task.id, id, "Report: [preuve](https://example.test/wrong)");
	expect(service.comments(scope, task.id).comments[0]?.body).toBe(original);
	service.saveCommentReformulation(scope, task.id, id, formatted);
	service.saveCommentReformulation(scope, task.id, id, "Late duplicate");
	expect(database.prepare("SELECT body FROM task_comment WHERE id=?").get(id)?.body).toBe(formatted);
	const reopened = harness(path).service;
	expect(reopened.comments(scope, task.id).comments).toMatchObject([{ id, body: formatted, author: "user" }]);
	expect(reopened.comment(scope, task.id, id, original, "user").body).toBe(formatted);
	expect(() => reopened.comment(scope, task.id, id, "Changed source", "user")).toThrow("conflict");
	expect(reopened.get(scope, task.id).serial).toBe(task.serial);
});

test("keeps unsupported links and image destinations safe before replacing a comment", () => {
	const { service, scope } = harness();
	const task = service.create(scope, randomUUID(), taskInput.parse({ title: "Links" }), "user");
	const source =
		"Compare [report](./old.md), [file](file:///tmp/original), ![chart](https://example.test/a) and `file:///tmp/code`.";
	const id = randomUUID();
	service.comment(scope, task.id, id, source, "user");
	for (const [before, after] of [
		["./old.md", "./different.md"],
		["file:///tmp/original", "file:///tmp/different"],
		["file:///tmp/code", "file:///tmp/other"],
		["https://example.test/a", "https://example.test/b"],
	] as const) {
		service.saveCommentReformulation(scope, task.id, id, source.replace(before, after));
		expect(service.comments(scope, task.id).comments[0]?.body).toBe(source);
	}
});

test("consolidates legacy comment text without losing links, attachments or unread state", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-tasks-legacy-comments-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const { service, database, scope } = harness(path);
	const task = service.create(scope, randomUUID(), taskInput.parse({ title: "Legacy task" }), "user");
	const file = { name: "note.txt", mime: "text/plain", data: Buffer.from("note").toString("base64") };
	const source = "[Test](https://example.test/result) ok";
	const optimized = "[Test](https://example.test/result) réussi.";
	const { comment: first } = service.commentFromPanel(scope, task.id, randomUUID(), source, [file]);
	const { comment: second } = service.commentFromPanel(scope, task.id, randomUUID(), source, []);
	database.exec(`CREATE TABLE comment_reformulation (
		task_id TEXT NOT NULL, comment_id TEXT NOT NULL, body TEXT NOT NULL,
		PRIMARY KEY(task_id,comment_id),
		FOREIGN KEY(task_id,comment_id) REFERENCES task_comment(task_id,id) ON DELETE CASCADE
	) STRICT;`);
	const legacy = database.prepare("INSERT INTO comment_reformulation VALUES (?,?,?)");
	legacy.run(task.id, first.id, optimized);
	legacy.run(task.id, second.id, "[Test](https://example.test/different)");
	const migrated = harness(path);
	expect(migrated.service.commentNotifications(scope).map(({ comment }) => comment)).toEqual([
		{ ...first, body: optimized },
		second,
	]);
	expect(migrated.database.prepare("SELECT count(*) AS count FROM comment_reformulation").get()?.count).toBe(
		0,
	);
	expect(migrated.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	expect(migrated.service.commentFromPanel(scope, task.id, first.id, source, [file]).comment.body).toBe(
		optimized,
	);
	expect(migrated.service.get(scope, task.id).serial).toBe(task.serial);
});

test("reuses instructions across projects and chats without losing their library history", () => {
	const { database } = harness();
	const one = randomUUID();
	const two = randomUUID();
	const oneThread = randomUUID();
	const twoThread = randomUUID();
	let now = 1;
	const service = new TaskService(new TaskRepository(database), () => now, {
		list: () => [
			{ id: one, name: "Project One" },
			{ id: two, name: "Project Two" },
		],
		forThread: (thread) => (thread === oneThread ? one : thread === twoThread ? two : undefined),
	});
	const boards = [service.bind(oneThread), service.bind(twoThread), service.bind(randomUUID())] as const;
	const [first, second, other] = boards;
	const shared = service.saveInstructionEntry(
		first,
		{
			entryId: randomUUID(),
			expectedRevision: 0,
			body: "Shared instruction",
			permanent: false,
			targets: [
				{ kind: "project", projectId: one },
				{ kind: "project", projectId: two },
			],
		},
		true,
		true,
	);
	expect(service.listInstructionEntries(first).map(({ id }) => id)).toEqual([shared.id]);
	expect(service.listInstructionEntries(second).map(({ id }) => id)).toEqual([shared.id]);
	expect(service.listInstructionEntries(other)).toEqual([]);
	now = 10;
	const newest = service.saveInstructionEntry(
		first,
		{
			entryId: randomUUID(),
			expectedRevision: 0,
			body: "Latest instruction",
			permanent: false,
			targets: [{ kind: "chat" }],
		},
		true,
		true,
	);
	expect(service.listInstructionLibrary(other).map(({ id }) => id)).toEqual([newest.id, shared.id]);
	expect(service.listInstructionLibrary(other)[0]?.bindings).toEqual([{ kind: "other_chat" }]);
	service.setInstructionBindings(
		first,
		shared.id,
		shared.revision,
		[{ kind: "project", projectId: one }],
		false,
	);
	expect(service.listInstructionEntries(first).map(({ id }) => id)).toEqual([newest.id]);
	expect(service.listInstructionEntries(second).map(({ id }) => id)).toEqual([shared.id]);
	service.setInstructionBindings(
		second,
		shared.id,
		shared.revision,
		[{ kind: "project", projectId: two }],
		false,
	);
	expect(service.listInstructionEntries(second)).toEqual([]);
	expect(service.listInstructionLibrary(other).find(({ id }) => id === shared.id)).toMatchObject({
		body: shared.body,
		bindings: [],
	});
	service.setInstructionBindings(other, shared.id, shared.revision, [{ kind: "chat" }], true);
	expect(service.listInstructionEntries(other).map(({ id }) => id)).toEqual([shared.id]);
	service.setInstructionBindings(other, shared.id, shared.revision, [{ kind: "global" }], true);
	expect(service.listInstructionEntries(other).map(({ id }) => id)).toEqual([shared.id]);
	expect(service.listInstructionEntries(second).map(({ id }) => id)).toEqual([shared.id]);
});

test("deletes only an unbound instruction at the confirmed revision and rejects stale writes", () => {
	const { service, database, scope } = harness();
	const other = service.bind(randomUUID());
	const entryId = randomUUID();
	const draft = {
		entryId,
		expectedRevision: 0,
		body: "Keep this instruction until its last assignment is removed.",
		permanent: false,
		targets: [{ kind: "chat" }] as const,
	};
	service.saveInstructionEntry(scope, { ...draft, targets: [...draft.targets] });
	service.setInstructionBindings(other, entryId, 1, [{ kind: "chat" }], true);
	service.setInstructionBindings(scope, entryId, 1, [{ kind: "chat" }], false);
	expect(() => service.deleteUnboundInstruction(scope, entryId, 1)).toThrow("conflict");
	service.setInstructionBindings(other, entryId, 1, [{ kind: "chat" }], false);
	expect(() => service.deleteUnboundInstruction(scope, entryId, 2)).toThrow("conflict");
	service.saveInstructionReformulation(
		scope,
		entryId,
		1,
		{ title: "Keep the instruction", body: draft.body },
		true,
	);
	service.deleteUnboundInstruction(scope, entryId, 1);
	service.saveInstructionReformulation(scope, entryId, 1, { title: "Late response", body: draft.body }, true);
	expect(service.listInstructionLibrary(scope)).toEqual([]);
	expect(
		database.prepare("SELECT body,removed,revision FROM instruction_entry WHERE id=?").get(entryId),
	).toEqual({
		body: "",
		removed: 1,
		revision: 2,
	});
	expect(
		database.prepare("SELECT entry_id FROM instruction_reformulation WHERE entry_id=?").get(entryId),
	).toBeUndefined();
	expect(() => service.setInstructionBindings(scope, entryId, 1, [{ kind: "chat" }], true)).toThrow(
		"conflict",
	);
	expect(() => service.saveInstructionEntry(scope, { ...draft, targets: [...draft.targets] })).toThrow(
		"conflict",
	);
});

test("serves the last task page, an earlier cursor and the latest Codex-authored task", () => {
	const { service, scope } = harness();
	let lastAgentOrdinal = 0;
	for (let index = 0; index < 52; index++) {
		const author = index % 2 === 0 ? "agent" : "user";
		const task = service.create(scope, randomUUID(), taskInput.parse({ title: `Task ${index}` }), author);
		if (author === "agent") lastAgentOrdinal = task.ordinal;
	}
	const tail = service.list(scope, 0, [], true, { tail: true });
	expect(tail.tasks).toHaveLength(2);
	expect(tail.tasks[0]?.title).toBe("Task 50");
	expect(tail.tasks.at(-1)?.title).toBe("Task 51");
	expect(tail.next).toBeNull();
	expect(tail.viewport).toMatchObject({ latestAgentOrdinal: lastAgentOrdinal, previousAfter: 0 });
});

test("preserves the first creation and actual finish times through verification and reopening", () => {
	const { database } = harness();
	let now = 1000;
	const service = new TaskService(new TaskRepository(database), () => now);
	const scope = service.bind(randomUUID());
	const task = service.create(scope, randomUUID(), taskInput.parse({ title: "Measure task timing" }), "user");
	expect(task.firstCreatedAt).toBe(1000);
	now = 2000;
	const claimed = service.claim({ scope, taskId: task.id, expectedSerial: task.serial, assignee: "thread" });
	now = 3000;
	const done = service.settle({
		scope,
		taskId: task.id,
		claimId: claimed.claimId,
		state: "done",
		verification: { work: "Worked", check: "Checked", result: "Passed", evidence: "Test receipt" },
	});
	expect(done.completedAt).toBe(3000);
	now = 4000;
	const checked = service.validate(
		{ scope, taskId: task.id, expectedSerial: done.serial },
		"Checked visually",
	);
	expect(checked.completedAt).toBe(3000);
	expect(service.list(scope).tasks[0]?.completedAt).toBe(3000);
	database.prepare("DELETE FROM task_completion WHERE task_id=?").run(task.id);
	expect(service.get(scope, task.id)).toMatchObject({ completedAt: 4000, completedAtEstimated: true });
	now = 5000;
	const reopened = service.requeue({ scope, taskId: task.id, expectedSerial: checked.serial });
	expect(reopened.completedAt).toBeUndefined();
	now = 6000;
	const doneAgain = service.validate(
		{ scope, taskId: task.id, expectedSerial: reopened.serial },
		"Checked again",
	);
	expect(doneAgain.firstCreatedAt).toBe(1000);
	expect(doneAgain.completedAt).toBe(6000);
});

test("archives existing legacy documents while retaining their assignment and old-editor revision", () => {
	const folder = mkdtempSync(join(tmpdir(), "session-task-migrate-instructions-"));
	resources.push(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "tasks.sqlite3");
	const old = new DatabaseSync(path);
	old.exec(SCHEMA);
	const scope = randomUUID();
	old.prepare("INSERT INTO board VALUES(?,?)").run(randomUUID(), scope);
	old.prepare("INSERT INTO board_instructions VALUES(?,?,?)").run(scope, 3, "Legacy in one chat");
	old.prepare("INSERT INTO permanent_instructions VALUES(1,?,?)").run(4, "Legacy everywhere");
	old.close();
	const { service, scope: other } = harness(path);
	const history = service.listInstructionLibrary(other);
	const local = history.find((entry) => entry.body === "Legacy in one chat");
	if (!local) throw new Error("migrated chat instruction is missing");
	expect(local.bindings).toEqual([{ kind: "other_chat" }]);
	expect(service.readInstructions(scope)).toEqual({
		chat: { revision: 3, body: "Legacy in one chat" },
		permanent: { revision: 4, body: "Legacy everywhere" },
	});
	service.saveInstructions(scope, { chat: { revision: 3, body: "Legacy edited" } });
	expect(service.listInstructionEntries(scope).map(({ body }) => body)).toContain("Legacy edited");
	expect(service.listInstructionLibrary(other).find(({ id }) => id === local.id)?.body).toBe("Legacy edited");
	service.setInstructionBindings(scope, local.id, 4, [{ kind: "chat" }], false);
	expect(service.readInstructions(scope).chat).toEqual({ revision: 4, body: "" });
	expect(service.listInstructionLibrary(other).find(({ id }) => id === local.id)?.body).toBe("Legacy edited");
	service.deleteUnboundInstruction(scope, local.id, 4);
	expect(service.readInstructions(scope).chat).toEqual({ revision: 5, body: "" });
	expect(() => service.saveInstructions(scope, { chat: { revision: 4, body: "Stale editor" } })).toThrow(
		"conflict",
	);
	service.saveInstructions(scope, { chat: { revision: 5, body: "A new legacy entry" } });
	expect(service.readInstructions(scope).chat).toEqual({ revision: 6, body: "A new legacy entry" });
	expect(service.listInstructionLibrary(scope).some(({ id }) => id === local.id)).toBe(false);
	service.saveInstructions(other, { chat: { revision: 0, body: "Another old client" } });
	const latest = service.saveInstructionEntry(
		other,
		{
			entryId: "chat",
			expectedRevision: 1,
			body: "Another old client edited",
			permanent: false,
			targets: [],
		},
		true,
		true,
	);
	expect(latest.bindings).toEqual([{ kind: "chat" }]);
	expect(service.listInstructionEntries(other).map(({ body }) => body)).toContain(
		"Another old client edited",
	);
});
