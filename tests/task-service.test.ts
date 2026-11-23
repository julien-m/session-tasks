/** Verifies the task invariants on the actual SQLite driver. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { taskInput } from "../src/contract.ts";
import { openDatabase, TaskRepository } from "../src/repository.ts";
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
