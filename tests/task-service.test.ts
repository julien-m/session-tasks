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
	const reopened = service.requeue({ ...command, expectedSerial: done.serial });
	expect(reopened).toMatchObject({ state: "queued", receipt: null, revision: task.revision });
	expect(reopened.verification).toBeUndefined();
	expect(service.list(scope).counts.done).toBe(0);
	expect(() => service.settle({ ...settle, verification })).toThrow("conflict");
});
