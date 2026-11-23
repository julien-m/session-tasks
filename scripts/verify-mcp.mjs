/** Exercises the supervised MCP service and the real bundled prompt hook. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL("http://127.0.0.1:46173/mcp");
const transport = new StreamableHTTPClientTransport(endpoint);
const client = new Client({ name: "session-tasks-verifier", version: "0.1.0" });
const limits = { timeout: 5000, maxTotalTimeout: 5000 };
const session = randomUUID();
const hook = (event, fields = {}) =>
	JSON.parse(
		execFileSync(process.execPath, ["dist/hook.mjs"], {
			input: JSON.stringify({ session_id: session, hook_event_name: event, ...fields }),
			timeout: 5000,
			encoding: "utf8",
		}),
	);
const injected = hook("UserPromptSubmit");
const scope = injected.hookSpecificOutput.additionalContext.match(/scope=([0-9a-f-]+)/)?.[1];
assert.ok(scope);
const taskId = randomUUID();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfcAAAAASUVORK5CYII=";
const invoke = (name, args) => client.callTool({ name, arguments: { scope, ...args } }, limits);
const success = async (name, args) => {
	const result = await invoke(name, args);
	assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
	return result;
};

await client.connect(transport, limits);
try {
	const catalog = await client.listTools({}, limits);
	const opener = catalog.tools.find((tool) => tool.name === "open_session_tasks");
	assert.ok(opener?._meta.ui.resourceUri);
	assert.match(opener.icons?.[0]?.src ?? "", /^data:image\/png;base64,/);
	const page = await client.readResource({ uri: "ui://session-tasks/tasks.html" }, limits);
	assert.equal(page.contents[0].mimeType, "text/html;profile=mcp-app");
	assert.equal(page.contents[0]._meta["openai/ui"].preferredDisplayMode, "fullscreen");
	const launch = await success("open_session_tasks", {});
	assert.equal(launch._meta.binding, scope);
	const first = (
		await success("task_panel_create", {
			taskId,
			input: {
				title: "Verify fixture",
				body: "\tconst check = 1;\n",
				files: [{ name: "fixture.png", mime: "image/png", data: png }],
			},
		})
	).structuredContent;
	assert.equal(first.mode, "auto");
	assert.equal(first.author, "user");
	assert.equal(hook("Stop").decision, "block");
	assert.deepEqual(hook("Stop", { stop_hook_active: true }), {});
	const taking = (
		await success("session_tasks_claim", { taskId, expectedSerial: first.serial, assignee: "example-worker" })
	).structuredContent;
	const attachmentId = first.attachments[0].id;
	const image = await success("session_tasks_attachment", { taskId, attachmentId });
	assert.deepEqual(image.content[0], { type: "image", mimeType: "image/png", data: png });
	const revised = (
		await success("task_panel_edit", {
			taskId,
			expectedRevision: first.revision,
			input: { title: "Verify revised fixture", body: first.body, mode: "thread", keep: [attachmentId] },
		})
	).structuredContent;
	assert.equal(
		(await invoke("session_tasks_settle", { taskId, claimId: taking.claimId, state: "done", receipt: "old" }))
			.structuredContent.error,
		"conflict",
	);
	const history = (await success("task_panel_history", { taskId })).structuredContent.revisions;
	assert.deepEqual(
		history.map((revision) => [revision.revision, revision.body]),
		[
			[2, first.body],
			[1, first.body],
		],
	);
	assert.equal(
		(await invoke("session_tasks_get", { scope: randomUUID(), taskId })).structuredContent.error,
		"not_found",
	);
	const latest = (
		await success("session_tasks_claim", { taskId, expectedSerial: revised.serial, assignee: "thread" })
	).structuredContent;
	const settle = { taskId, claimId: latest.claimId, state: "done" };
	assert.equal(
		(await invoke("session_tasks_settle", { ...settle, receipt: "Done" })).structuredContent.error,
		"verification_required",
	);
	const verification = {
		work: "Revised the task and retained the image",
		check: "Compare the scope, history and attachment bytes over MCP",
		result: "The exact attachment bytes and two revisions were returned",
		evidence: "Image and revision history assertions in scripts/verify-mcp.mjs",
	};
	const done = (await success("session_tasks_settle", { ...settle, verification })).structuredContent;
	assert.deepEqual(done.verification, verification);
	assert.equal((await success("task_panel_list", {})).structuredContent.counts.done, 1);
	const reopened = (await success("task_panel_restore", { taskId, expectedSerial: done.serial }))
		.structuredContent;
	assert.equal(reopened.state, "queued");
	assert.equal(reopened.verification, undefined);
	assert.equal((await success("task_panel_list", {})).structuredContent.counts.done, 0);
	await success("task_panel_cancel", { taskId, expectedSerial: reopened.serial });
	assert.deepEqual(hook("Stop"), {});
	assert.equal((await success("task_panel_list", {})).structuredContent.tasks.length, 0);
	assert.equal((await success("task_panel_list", { cancelled: true })).structuredContent.tasks.length, 1);
	console.log(
		"Verified MCP discovery and icon, panel metadata, scope, hooks, attachment bytes, stale claim, history, completion evidence, reopening and cancellation.",
	);
} finally {
	await client.close();
}
