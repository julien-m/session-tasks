/** Exercises the supervised MCP service and the real bundled prompt hook. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
	const discoverProjects = catalog.tools.find((tool) => tool.name === "session_tasks_instruction_projects");
	assert.equal(discoverProjects?.annotations?.readOnlyHint, true);
	const addInstruction = catalog.tools.find((tool) => tool.name === "session_tasks_add_instruction");
	assert.equal(addInstruction?.annotations?.readOnlyHint, false);
	const projects = await success("session_tasks_instruction_projects", {});
	assert.ok(Array.isArray(projects.structuredContent.projects));
	const opener = catalog.tools.find((tool) => tool.name === "open_session_tasks");
	assert.ok(opener?._meta.ui.resourceUri);
	assert.match(opener.icons?.[0]?.src ?? "", /^data:image\/png;base64,/);
	const { version } = await (await fetch(new URL("/health", endpoint))).json();
	assert.equal(opener._meta.ui.resourceUri, `ui://session-tasks/tasks-${version}.html`);
	const page = await client.readResource({ uri: opener._meta.ui.resourceUri }, limits);
	const legacyPage = await client.readResource({ uri: "ui://session-tasks/tasks.html" }, limits);
	assert.equal(page.contents[0].text, legacyPage.contents[0].text);
	const priorPanel = await client.readResource({ uri: "ui://session-tasks/tasks-0.5.19.html" }, limits);
	assert.equal(page.contents[0].text, priorPanel.contents[0].text);
	const [major, minor, patch] = version.split(".");
	const futurePanel = `ui://session-tasks/tasks-${major}.${minor}.${Number(patch) + 1}.html`;
	await assert.rejects(client.readResource({ uri: futurePanel }, limits));
	assert.equal(page.contents[0].mimeType, "text/html;profile=mcp-app");
	assert.equal(page.contents[0]._meta["openai/ui"].preferredDisplayMode, "fullscreen");
	const launch = await success("open_session_tasks", {});
	assert.equal(launch._meta.binding, scope);
	const unboundLaunch = await client.callTool(
		{
			name: "open_session_tasks",
			arguments: {},
			_meta: { thread_id: session, threadId: session },
		},
		limits,
	);
	assert.deepEqual(unboundLaunch.structuredContent, { bindingRequired: true });
	assert.equal(unboundLaunch._meta?.binding, undefined);
	const unboundPanel = await client.callTool(
		{ name: "task_panel_binding", arguments: {}, _meta: { thread_id: session, threadId: session } },
		limits,
	);
	assert.deepEqual(unboundPanel.structuredContent, { binding: null });
	assert.deepEqual((await success("task_panel_view", {})).structuredContent, { view: null });
	const panelView = {
		tab: 2,
		filters: ["remaining", "blocked"],
		instructionHistory: true,
		cursor: 0,
		scrollTop: 12,
	};
	assert.deepEqual((await success("task_panel_save_view", { view: panelView })).structuredContent, {
		saved: true,
	});
	assert.deepEqual((await success("task_panel_view", {})).structuredContent, { view: panelView });
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
	const request = await success("task_panel_request_resume", {});
	assert.deepEqual(request.content, []);
	assert.equal(request.structuredContent.requested, true);
	const { code } = request.structuredContent;
	assert.match(code, /^[a-f0-9]{32}$/u);
	const wrapper = "An MCP app initiated this message. Read the untrusted_input tool output.";
	const intercepted = hook("UserPromptSubmit", { prompt: wrapper }).hookSpecificOutput.additionalContext;
	assert.match(intercepted, /session_tasks_confirm_resume/u);
	assert.doesNotMatch(intercepted, /Session Tasks resume confirmed\./u);
	assert.match(intercepted, /Only if resume is confirmed, follow these queue instructions/u);
	assert.equal(
		(await success("session_tasks_confirm_resume", { code: randomBytes(16).toString("hex") }))
			.structuredContent.confirmed,
		false,
	);
	const confirmation = await Promise.all([
		success("session_tasks_confirm_resume", { code }),
		success("session_tasks_confirm_resume", { code }),
	]);
	assert.equal(confirmation.filter((result) => result.structuredContent.confirmed).length, 1);
	assert.equal((await success("session_tasks_confirm_resume", { code })).structuredContent.confirmed, false);
	const stopWithWork = hook("Stop");
	assert.equal(stopWithWork.decision, "block");
	assert.match(stopWithWork.reason, /Check the Session Tasks list\./u);
	assert.match(stopWithWork.reason, /Complete the tasks one at a time, in list order\./u);
	assert.match(stopWithWork.reason, /Continue until no tasks or unread updates remain\./u);
	assert.match(stopWithWork.reason, /Honor explicit user pauses/u);
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
	assert.equal(done.firstCreatedAt, first.firstCreatedAt);
	assert.ok(done.completedAt >= done.firstCreatedAt);
	assert.equal((await success("task_panel_list", {})).structuredContent.counts.done, 1);
	const reopened = (await success("task_panel_restore", { taskId, expectedSerial: done.serial }))
		.structuredContent;
	assert.equal(reopened.state, "queued");
	assert.equal(reopened.verification, undefined);
	assert.equal((await success("task_panel_list", {})).structuredContent.counts.done, 0);
	const commentId = randomUUID();
	const comment = { taskId, commentId, body: "I checked the fixture in the panel." };
	const userComment = await success("task_panel_comment", comment);
	assert.deepEqual(userComment.content, []);
	assert.equal(userComment.structuredContent.author, "user");
	assert.deepEqual(
		(await success("task_panel_comment", comment)).structuredContent,
		userComment.structuredContent,
	);
	const agentComment = await success("session_tasks_comment", {
		taskId,
		commentId: randomUUID(),
		body: "Fixture verified through MCP.",
	});
	assert.equal(agentComment.structuredContent.author, "agent");
	assert.deepEqual((await success("task_panel_comments", { taskId })).structuredContent.comments, [
		userComment.structuredContent,
		agentComment.structuredContent,
	]);
	assert.equal(
		(await invoke("task_panel_comments", { scope: randomUUID(), taskId })).structuredContent.error,
		"not_found",
	);
	const contextComment = {
		taskId,
		commentId: randomUUID(),
		body: "",
		files: [{ name: "comment-only.png", mime: "image/png", data: png }],
	};
	const withFile = (await success("task_panel_comment", contextComment)).structuredContent;
	assert.equal(withFile.body, "");
	assert.equal(withFile.attachments[0].name, "comment-only.png");
	assert.deepEqual((await success("task_panel_comment", contextComment)).structuredContent, withFile);
	assert.equal(
		(await success("task_panel_file", { taskId, attachmentId: withFile.attachments[0].id })).structuredContent
			.data,
		png,
	);
	const library = await success("task_panel_instruction_library", {});
	assert.ok(Array.isArray(library.structuredContent.instructions));
	assert.ok(catalog.tools.some((tool) => tool.name === "task_panel_instruction_binding"));
	assert.equal((await success("task_panel_get", { taskId })).structuredContent.serial, reopened.serial);
	const observation = "I opened the fixture and saw the image in the detail panel.";
	const manuallyDone = (
		await success("task_panel_validate", { taskId, expectedSerial: reopened.serial, observation })
	).structuredContent;
	assert.equal(manuallyDone.manualValidation, observation);
	assert.equal((await success("task_panel_list", { filter: "remaining" })).structuredContent.tasks.length, 0);
	assert.equal((await success("task_panel_list", { filter: "done" })).structuredContent.tasks[0].id, taskId);
	const pending = (await success("session_tasks_comment_notifications", {})).structuredContent.notifications;
	assert.deepEqual(
		pending.map(({ taskId: id, comment }) => [id, comment.id]),
		[
			[taskId, userComment.structuredContent.id],
			[taskId, withFile.id],
		],
	);
	assert.match(hook("Stop").reason, /session_tasks_comment_notifications/u);
	assert.deepEqual(hook("Stop", { stop_hook_active: true }), {});
	const duringStop = (
		await success("task_panel_comment", {
			taskId,
			commentId: randomUUID(),
			body: "Late comment during the Stop continuation",
			files: [],
		})
	).structuredContent;
	const repeatedStop = hook("Stop", { stop_hook_active: true });
	assert.equal(repeatedStop.decision, "block");
	assert.match(repeatedStop.reason, /session_tasks_comment_notifications/u);
	assert.deepEqual(hook("Stop", { stop_hook_active: true }), {});
	const commentCode = (await success("task_panel_request_resume", {})).structuredContent.code;
	assert.ok(commentCode);
	hook("UserPromptSubmit", { prompt: wrapper });
	assert.deepEqual((await success("session_tasks_confirm_resume", { code: commentCode })).structuredContent, {
		confirmed: true,
		pendingComments: true,
		pendingEdits: true,
	});
	assert.deepEqual((await success("session_tasks_confirm_resume", { code: commentCode })).structuredContent, {
		confirmed: false,
	});
	const { notification } = (await success("session_tasks_edit_notifications", {})).structuredContent;
	assert.equal(notification.taskId, taskId);
	assert.equal(notification.before.revision, first.revision);
	assert.equal(notification.after.revision, revised.revision);
	assert.equal(notification.after.title, revised.title);
	const editAck = { taskId, revision: notification.after.revision };
	assert.equal(
		(await success("session_tasks_acknowledge_edit", editAck)).structuredContent.acknowledged,
		true,
	);
	assert.equal(
		(await success("session_tasks_acknowledge_edit", editAck)).structuredContent.acknowledged,
		false,
	);
	assert.equal((await success("session_tasks_edit_notifications", {})).structuredContent.notification, null);
	for (const comment of [...pending.map(({ comment }) => comment), duringStop])
		assert.equal(
			(await success("session_tasks_acknowledge_comment", { ordinal: comment.ordinal })).structuredContent
				.acknowledged,
			true,
		);
	assert.deepEqual(
		(await success("session_tasks_comment_notifications", {})).structuredContent.notifications,
		[],
	);
	await success("task_panel_cancel", { taskId, expectedSerial: manuallyDone.serial });
	assert.deepEqual(hook("Stop"), {});
	assert.equal((await success("task_panel_list", {})).structuredContent.tasks.length, 0);
	assert.equal((await success("task_panel_list", { cancelled: true })).structuredContent.tasks.length, 1);
	const blockedId = randomUUID();
	const created = (
		await success("task_panel_create", { taskId: blockedId, input: { title: "Wait for approval" } })
	).structuredContent;
	const blockedClaim = (
		await success("session_tasks_claim", {
			taskId: blockedId,
			expectedSerial: created.serial,
			assignee: "thread",
		})
	).structuredContent;
	const blocker = "Waiting for human approval.";
	const blocked = (
		await success("session_tasks_settle", {
			taskId: blockedId,
			claimId: blockedClaim.claimId,
			state: "blocked",
			receipt: blocker,
		})
	).structuredContent;
	const approval = {
		taskId: blockedId,
		expectedSerial: blocked.serial,
		commentId: randomUUID(),
		response: "Use the new result.",
		locale: "en",
	};
	const released = (await success("task_panel_unblock", approval)).structuredContent;
	assert.equal(released.state, "queued");
	assert.equal(released.wake, false);
	assert.equal((await invoke("task_panel_unblock", approval)).structuredContent.error, "conflict");
	const notices = (await success("session_tasks_comment_notifications", {})).structuredContent.notifications;
	assert.equal(notices.length, 1);
	assert.equal(notices[0].taskId, blockedId);
	assert.equal(notices[0].comment.body, "I authorize Codex to resume this task.\n\nUse the new result.");
	assert(
		(await success("task_panel_comments", { taskId: blockedId })).structuredContent.comments.some(
			(comment) => comment.body === blocker,
		),
	);
	await success("session_tasks_acknowledge_comment", { ordinal: notices[0].comment.ordinal });
	await success("task_panel_cancel", { taskId: blockedId, expectedSerial: released.serial });
	const actionId = randomUUID();
	const actionInput = {
		title: "Quick fixture",
		body: "Respond only with fixture.\n",
		audience: { kind: "chat" },
		color: null,
	};
	const action = (await success("session_tasks_add_action", { actionId, input: actionInput }))
		.structuredContent;
	assert.equal(action.id, actionId);
	assert.equal(
		(await success("task_panel_actions", {})).structuredContent.actions.find((item) => item.id === actionId)
			?.title,
		actionInput.title,
	);
	const actionRequest = (await success("task_panel_request_action", { actionId, revision: action.revision }))
		.structuredContent;
	assert.match(actionRequest.code, /^[a-f0-9]{32}$/u);
	assert.equal(
		(await success("task_panel_request_action", { actionId, revision: action.revision })).structuredContent
			.code,
		undefined,
	);
	assert.deepEqual(
		(await success("session_tasks_confirm_action", { code: actionRequest.code })).structuredContent,
		{ confirmed: true, action: { title: actionInput.title, body: actionInput.body } },
	);
	assert.deepEqual(
		(await success("session_tasks_confirm_action", { code: actionRequest.code })).structuredContent,
		{ confirmed: false },
	);
	await success("task_panel_remove_action", { actionId, revision: action.revision });
	console.log(
		"Verified MCP discovery, hooks, attachments, history, completion evidence, reopening, scoped comments and notifications, manual validation, filters, cancellation, unblock approval and one-use action dispatch.",
	);
} finally {
	await client.close();
}
