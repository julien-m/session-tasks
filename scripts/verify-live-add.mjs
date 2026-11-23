/** Verifies that an active Codex turn completes a task added silently through the panel. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL("http://127.0.0.1:46173/mcp");
const limits = { timeout: 5000, maxTotalTimeout: 5000 };
const client = new Client({ name: "session-tasks-live-verifier", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(endpoint), limits);
const child = spawn(
	process.env.SESSION_TASKS_CODEX_CLI || "codex",
	[
		"exec",
		"--ephemeral",
		"--json",
		"-c",
		'model_reasoning_effort="medium"',
		"-C",
		process.cwd(),
		"Fais une petite vérification dans ce chat : calcule 23 + 19 avec une commande shell, puis indique le résultat.",
	],
	{ stdio: ["ignore", "pipe", "ignore"] },
);
const stopped = once(child, "close");
const timer = setTimeout(() => child.kill("SIGTERM"), 150000);
const taskId = randomUUID();
let scope;
let created = false;
let followUpClaimed = false;
let followUpSettled = false;
let completed = false;

async function call(name, args) {
	const result = await client.callTool({ name, arguments: { scope, ...args } }, limits);
	assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
	return result.structuredContent;
}

try {
	for await (const line of createInterface({ input: child.stdout })) {
		const event = JSON.parse(line);
		const item = event.item;
		if (event.type === "turn.completed") completed = true;
		if (event.type !== "item.completed" || item?.server !== "session-tasks" || item.status !== "completed")
			continue;
		if (!created && item.tool === "session_tasks_claim") {
			scope = item.arguments.scope;
			const current = await call("task_panel_list", {});
			assert.equal(current.tasks.find((task) => task.id === item.arguments.taskId)?.state, "running");
			const added = await call("task_panel_create", {
				taskId,
				input: {
					title: "Calculer 13 × 7",
					mode: "thread",
					body: "Calcule 13 × 7 avec une commande shell et vérifie le résultat dans ce chat.",
				},
			});
			assert.equal(added.author, "user");
			assert.equal(added.state, "queued");
			assert.equal(added.wake, false);
			created = true;
			console.log("Panel-side addition committed while the first task was running.");
			continue;
		}
		if (item.arguments?.taskId !== taskId) continue;
		if (item.tool === "session_tasks_claim") followUpClaimed = true;
		if (item.tool === "session_tasks_settle" && item.arguments.state === "done") followUpSettled = true;
	}
	const [code, signal] = await stopped;
	assert.equal(signal, null);
	assert.equal(code, 0);
	assert.equal(completed, true);
	assert.equal(created, true);
	assert.equal(followUpClaimed, true);
	assert.equal(followUpSettled, true);
	const board = await call("task_panel_list", {});
	assert.equal(board.counts.running + board.counts.queued, 0);
	assert.equal(board.tasks.find((task) => task.id === taskId)?.state, "done");
	console.log(
		"PASS: Codex claimed and completed the panel addition in the same turn, without a chat message.",
	);
} finally {
	clearTimeout(timer);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await stopped;
	}
	await client.close();
}
