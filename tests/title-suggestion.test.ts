import { expect, test, vi } from "vitest";

const { completions } = vi.hoisted(() => ({
	completions: [] as Array<(output?: string) => void>,
}));

vi.mock("node:child_process", () => ({
	execFile: (
		_binary: string,
		_args: string[],
		_options: object,
		complete: (error: null, stdout: string) => void,
	) => {
		completions.push((output) =>
			complete(
				null,
				JSON.stringify({
					type: "item.completed",
					item: {
						type: "agent_message",
						text: output ?? JSON.stringify({ title: "Title", body: "Markdown" }),
					},
				}),
			),
		);
		return { stdin: { on() {}, end() {} } };
	},
}));

import {
	isInstructionReformulationFailed,
	isReformulationPending,
	scheduleReformulation,
	suggestQuickAction,
} from "../src/title-suggestion.ts";

test("keeps the written command if a quick-action preview drops an argument", async () => {
	const command = "git status --short";
	const preview = suggestQuickAction(command, "en");
	completions.shift()?.(JSON.stringify({ title: "Check Git", body: "git status" }));
	expect(await preview).toEqual({ title: "Check Git", body: command, color: null });
});

test("uses a palette color only when enabled and keeps the command arguments", async () => {
	const body = "Run test suite.\n\nnpm test -- --run";
	const answer = { title: "Run tests", body: "Run tests.\n\nnpm test -- --run", color: "#3a8f68" };
	const automatic = suggestQuickAction(body, "en", undefined, true);
	completions.shift()?.(JSON.stringify(answer));
	expect(await automatic).toEqual({ ...answer, body, color: "#3A8F68" });
	const manual = suggestQuickAction(body, "en");
	completions.shift()?.(JSON.stringify(answer));
	expect(await manual).toEqual({ ...answer, body, color: null });
});

test("accepts paragraph formatting without letting optimization change execution instructions", async () => {
	const body = "Prepare the release.\nConfirm with me before publishing.";
	const generate = async (source: string, proposed: string) => {
		const result = suggestQuickAction(source, "en");
		completions.shift()?.(JSON.stringify({ title: "Prepare release", body: proposed }));
		return (await result)?.body;
	};
	expect(await generate(body, "Prepare the release.\n\nConfirm with me before publishing.")).toBe(
		"Prepare the release.\n\nConfirm with me before publishing.",
	);
	expect(await generate(body, "Publish directly.")).toBe(body);
	expect(await generate("git status --short", "git status --short\ngit push")).toBe("git status --short");
	expect(await generate("echo done. date", "echo done.\n\ndate")).toBe("echo done. date");
});

test("reports an invalid model result and clears the failure on retry of the same revision", async () => {
	const source = { id: "failed-instruction", revision: 1, body: "Rule" };
	const save = vi.fn();
	const schedule = () => scheduleReformulation(source, "en", save, "instruction");
	expect(schedule()).toBe(true);
	completions.shift()?.("invalid JSON");
	await vi.waitFor(() => expect(isReformulationPending(source.id, 1, "instruction")).toBe(false));
	expect(isInstructionReformulationFailed(source.id, 1)).toBe(true);
	expect(isInstructionReformulationFailed(source.id, 2)).toBe(false);
	expect(save).not.toHaveBeenCalled();
	expect(schedule()).toBe(true);
	expect(isInstructionReformulationFailed(source.id, 1)).toBe(false);
	completions.shift()?.();
	await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
});

test("supersedes waiting edits and gives tasks a turn even when instructions fill their queue", async () => {
	const save = vi.fn();
	for (let index = 0; index < 16; index++) {
		expect(
			scheduleReformulation(
				{ id: `instruction-${index}`, revision: 1, body: "Rule" },
				"en",
				save,
				"instruction",
			),
		).toBe(true);
	}
	expect(completions).toHaveLength(2);
	expect(scheduleReformulation({ id: "other", revision: 1, body: "Rule" }, "en", save, "instruction")).toBe(
		false,
	);
	expect(
		scheduleReformulation({ id: "instruction-4", revision: 2, body: "New rule" }, "en", save, "instruction"),
	).toBe(true);
	expect(isReformulationPending("instruction-4", 1, "instruction")).toBe(false);
	expect(isReformulationPending("instruction-4", 2, "instruction")).toBe(true);

	const saveTask = vi.fn();
	expect(
		scheduleReformulation({ id: "task", revision: 1, title: "Task", body: "Details" }, "en", saveTask),
	).toBe(true);
	expect(isReformulationPending("task", 1)).toBe(true);
	completions.shift()?.();
	await vi.waitFor(() => expect(completions).toHaveLength(2));
	completions.pop()?.();
	await vi.waitFor(() => expect(saveTask).toHaveBeenCalledOnce());
});
