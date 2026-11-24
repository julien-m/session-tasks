/** Verifies the task invariants on the actual SQLite driver. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { localCodexProjects } from "../src/codex-projects.ts";
import { taskInput } from "../src/contract.ts";
import { taskHook } from "../src/hook.ts";
import { openDatabase, TaskRepository } from "../src/repository.ts";
import { SCHEMA } from "../src/schema.ts";
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
	expect(JSON.stringify(taskHook(service, prompt))).toContain("Discard Session Tasks instruction lists");
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
	expect(JSON.stringify(taskHook(service, hook))).toContain("Discard Session Tasks instruction lists");
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
