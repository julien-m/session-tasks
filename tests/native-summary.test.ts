/** Exercises the native summary data boundary and state markers without replacing Codex. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { expect, test } from "vitest";
import { taskInput } from "../src/contract.ts";
import { openDatabase, TaskRepository } from "../src/repository.ts";
import { TaskService } from "../src/task-service.ts";

type Row = { id: string; state: string; title: string };
type Board = { status: string; total?: number; tasks?: Row[] };

const require = createRequire(import.meta.url);
const { readBoard } = require("../native/read-board.cjs") as {
	readBoard(threadId: string, database: string): Promise<Board>;
};

test("native reader only returns current public rows for the exact chat", async () => {
	const folder = mkdtempSync(join(tmpdir(), "native-task-board-"));
	const path = join(folder, "tasks.sqlite3");
	const database = openDatabase(path);
	try {
		const service = new TaskService(new TaskRepository(database));
		const thread = randomUUID();
		const scope = service.bind(thread);
		const otherThread = randomUUID();
		const otherScope = service.bind(otherThread);
		const input = (title: string) => taskInput.parse({ title, body: "Private detail omitted from summary." });
		const queued = service.create(scope, randomUUID(), input("Visible task"), "user");
		service.create(otherScope, randomUUID(), input("Other chat"), "user");
		const cancelled = service.create(scope, randomUUID(), input("Cancelled task"), "user");
		service.cancel({ scope, taskId: cancelled.id, expectedSerial: cancelled.serial });
		const running = service.claim({
			scope,
			taskId: queued.id,
			expectedSerial: queued.serial,
			assignee: "thread",
		});
		expect(await readBoard(thread, path)).toEqual({
			status: "ready",
			total: 1,
			tasks: [{ id: queued.id, state: "running", title: queued.title }],
		});
		service.settle({
			scope,
			taskId: queued.id,
			claimId: running.claimId,
			state: "done",
			verification: {
				work: "Read the native summary",
				check: "Read the board after claiming the scoped task",
				result: "The exact running task was visible",
				evidence: "The scoped summary assertion in native-summary.test.ts",
			},
		});
		expect((await readBoard(thread, path)).tasks?.[0]?.state).toBe("done");
		expect((await readBoard(otherThread, path)).tasks?.map(({ title }) => title)).toEqual(["Other chat"]);
		expect(await readBoard("invalid", path)).toEqual({ status: "unavailable" });
	} finally {
		database.close();
		rmSync(folder, { recursive: true, force: true });
	}
});

test("native renderer distinguishes all visible states in a single semantic list", () => {
	const text = readFileSync(new URL("../native/summary-section.js", import.meta.url), "utf8");
	const tasks = ["queued", "running", "done", "blocked"].map((state) => ({
		id: randomUUID(),
		title: state,
		state,
	}));
	const node = (tag: string, props: Record<string, unknown>) => ({ tag, ...props });
	const section = vm.runInNewContext(`${text}\nSessionTasksNative({threadId:"test"})`, {
		a: { jsx: node, jsxs: node },
		h: {
			useState: () => [{ status: "ready", total: tasks.length, tasks }],
			useRef: () => ({}),
			useEffect: () => {},
		},
		B: { x: { Section: "section", SectionCount: "count" } },
		navigator: { language: "fr-FR" },
	});
	expect(section.title).toBe("Tâches");
	expect(section.titleSuffix.count).toBe(tasks.length);
	const list = section.children.children[0];
	expect(list.tag).toBe("ul");
	expect(
		list.children.map(({ children }: { children: Array<{ children: unknown; "aria-hidden"?: boolean }> }) => [
			children[0]?.children,
			children[0]?.["aria-hidden"],
		]),
	).toEqual([
		["○", true],
		["◉", true],
		["✓", true],
		["⊘", true],
	]);
});
