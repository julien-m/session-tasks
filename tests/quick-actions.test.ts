import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { taskHook } from "../src/hook.ts";
import { QuickActions } from "../src/quick-actions.ts";
import {
	quickActionCodePrefix,
	quickActionInput,
	quickActionPrompt,
	quickActionTitlePrefix,
} from "../src/quick-actions-contract.ts";
import { openDatabase, TaskRepository } from "../src/repository.ts";
import { TaskService } from "../src/task-service.ts";

test("scopes, orders and delivers saved actions once to the chat that requested them", () => {
	const database = openDatabase(":memory:");
	try {
		const repository = new TaskRepository(database);
		const service = new TaskService(repository);
		const thread = randomUUID();
		const other = randomUUID();
		const scope = service.bind(thread);
		const otherScope = service.bind(other);
		const projectId = randomUUID();
		let member = thread;
		let leaveDuringWrite = false;
		let now = 10_000;
		const actions = new QuickActions(
			database,
			repository,
			{
				forThread: (threadId) =>
					threadId === member && !(leaveDuringWrite && database.isTransaction) ? projectId : undefined,
				list: () => [{ id: projectId, name: "Fixture project" }],
			},
			() => now,
		);
		const input = quickActionInput.parse({
			title: "Test rapide",
			body: "Preserve this exactly.\n\ngit status --short\n",
			color: "#fedcba",
			audience: { kind: "global" },
		});
		const global = actions.save(scope, randomUUID(), 0, input);
		const chat = actions.save(scope, randomUUID(), 0, { ...input, audience: { kind: "chat" } });
		const project = actions.save(scope, randomUUID(), 0, {
			...input,
			audience: { kind: "projects", ids: [projectId] },
		});
		expect(global.color).toBe("#FEDCBA");
		expect(actions.list(otherScope).map(({ id, available }) => [id, available])).toEqual([
			[global.id, true],
			[project.id, false],
		]);
		expect(() => actions.request(otherScope, project.id, 1)).toThrow("conflict");
		expect(() => actions.request(otherScope, chat.id, 1)).toThrow("not_found");
		actions.move(scope, chat.id, global.id, chat.position, global.position);
		expect(actions.list(scope).map(({ id }) => id)).toEqual([chat.id, global.id, project.id]);
		const code = actions.request(scope, global.id, 1);
		if (!code) throw new Error("missing action code");
		expect(actions.request(scope, global.id, 1)).toBeUndefined();
		expect(actions.consume(otherScope, code)).toBeUndefined();
		expect(actions.consume(scope, code)).toEqual({ title: input.title, body: input.body });
		expect(actions.consume(scope, code)).toBeUndefined();
		const superseded = actions.request(scope, global.id, 1);
		if (!superseded) throw new Error("missing action code");
		const updated = actions.save(scope, global.id, 1, { ...input, title: "Nouveau titre" });
		expect(actions.consume(scope, superseded)).toBeUndefined();
		const suggestion = {
			title: "Voir les changements",
			body: "Inspect the repository.\n\ngit status --short",
			color: null,
		};
		actions.applySuggestion(scope, global, suggestion);
		expect(actions.get(scope, global.id)).toEqual(updated);
		const expired = actions.request(scope, global.id, updated.revision);
		if (!expired) throw new Error("missing action code");
		now += 30_000;
		expect(actions.consume(scope, expired)).toBeUndefined();
		actions.applySuggestion(scope, updated, suggestion);
		const optimized = actions.get(scope, updated.id);
		expect(optimized).toMatchObject({ ...suggestion, color: input.color, revision: updated.revision + 1 });
		const optimizedCode = actions.request(scope, optimized.id, optimized.revision);
		if (!optimizedCode) throw new Error("missing optimized action code");
		expect(actions.consume(scope, optimizedCode)).toEqual({ title: suggestion.title, body: suggestion.body });
		const priorMembership = actions.request(scope, project.id, 1);
		if (!priorMembership) throw new Error("missing project code");
		leaveDuringWrite = true;
		expect(actions.consume(scope, priorMembership)).toBeUndefined();
		member = other;
		expect(actions.list(otherScope).find(({ id }) => id === project.id)?.available).toBe(true);
		actions.remove(scope, chat.id, chat.revision);
		expect(() => actions.save(scope, chat.id, 0, { ...input, audience: { kind: "chat" } })).toThrow(
			"conflict",
		);
		const controlLine = `${quickActionCodePrefix}${code}`;
		const runHook = (prompt: string) =>
			JSON.stringify(taskHook(service, { hook_event_name: "UserPromptSubmit", session_id: thread, prompt }));
		for (const header of [quickActionPrompt, `${quickActionTitlePrefix}${input.title}`]) {
			const hook = runHook(`${header}\n\n${controlLine}`);
			expect(hook).toContain("session_tasks_confirm_action");
			expect(hook).not.toContain(input.title);
			expect(hook).not.toContain(input.body);
		}
		for (const malformed of [
			`${quickActionTitlePrefix}\n\n${controlLine}`,
			`${quickActionTitlePrefix}${input.title}\n\n${controlLine}\nunexpected`,
			`${quickActionTitlePrefix}${input.title}\n\n${quickActionCodePrefix}bad-code`,
		]) {
			expect(runHook(malformed)).not.toContain("session_tasks_confirm_action");
		}
	} finally {
		database.close();
	}
});
