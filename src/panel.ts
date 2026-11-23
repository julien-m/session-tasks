/** Embedded task panel. All data stays in its scoped tool calls. */
import {
	App,
	applyDocumentTheme,
	applyHostStyleVariables,
	type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import manifest from "../plugin.json" with { type: "json" };
import {
	acceptsContext,
	appendContextText,
	captureContext,
	contextTitle,
	encodeFiles,
	hasContext,
	type TransferredContext,
	validateFiles,
} from "./context-transfer.ts";
import {
	type Attachment,
	type BoardFilter,
	commentBody,
	id,
	MAX_PAGE,
	manualCheck,
	type Revision,
	type Task,
	type TaskComment,
	type TaskSummary,
} from "./contract.ts";
import { catalog } from "./messages.ts";
import type { BoardList, CommentsPage } from "./repository.ts";

const locale = /^fr(?:-|$)/i.test(navigator.language) ? "fr" : "en";
const t = catalog(locale);
const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
const safeImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const app = new App({ name: "Session Tasks", version: manifest.version }, {});
const POLL_MS = 1800;

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
	className?: string,
): HTMLElementTagNameMap[K] {
	const value = document.createElement(tag);
	if (text) value.textContent = text;
	if (className) value.className = className;
	return value;
}
function button(text: string, action: () => void, className = "quiet"): HTMLButtonElement {
	const control = element("button", text, className);
	control.type = "button";
	control.onclick = action;
	return control;
}
function group(...children: Node[]): HTMLDivElement {
	const wrapper = element("div", undefined, "group");
	wrapper.append(...children);
	return wrapper;
}
function field(caption: string, control: HTMLElement): HTMLLabelElement {
	const label = element("label", undefined, "field");
	label.append(element("span", caption), control);
	return label;
}

let scope: string | undefined;
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	if (!scope) throw new Error("invalid_scope");
	const response = await app.callServerTool(
		{ name: `task_panel_${name}`, arguments: { scope, ...args } },
		{ timeout: 10000, maxTotalTimeout: 10000 },
	);
	if (response.isError || !response.structuredContent)
		throw new Error(
			String((response.structuredContent as { error?: string } | undefined)?.error ?? "internal_error"),
		);
	return response.structuredContent as T;
}

async function createTask(
	command: Record<string, unknown>,
	deferWake = false,
): Promise<Task & { wake?: boolean }> {
	const board = scope;
	const saved = await call<Task & { wake?: boolean }>("create", command);
	if (!deferWake && scope === board && saved.wake && app.getHostCapabilities()?.message?.text) {
		void resumeChat(true);
	}
	return saved;
}

const main = element("main");
const progress = element("progress");
progress.setAttribute("aria-label", t.progress);
const progressText = element("span", undefined, "meta");
const progressGroup = element("div", undefined, "progress");
progressGroup.append(progress);
progressGroup.hidden = true;
const notice = element("p", t.loading, "notice");
notice.setAttribute("role", "status");
const rows = element("ul", undefined, "rows");
const transferNotice = element("div", undefined, "group transfer-notice");
transferNotice.setAttribute("role", "status");
const dropZone = element("p", t.dropHere, "drop-zone");
main.tabIndex = 0;
const dialog = element("dialog");
dialog.addEventListener("cancel", (event) => {
	if (mutation) event.preventDefault();
});
dialog.setAttribute("aria-labelledby", "task-dialog-title");
const dialogContent = element("div", undefined, "dialog-content");
dialog.append(dialogContent);
const add = button("+", () => showEditor(), "icon-button");
add.setAttribute("aria-label", t.add);
add.title = t.add;
add.disabled = true;
const quickAdd = element("form", undefined, "quick-add");
const quickTitle = element("input");
quickTitle.setAttribute("aria-label", t.quickAdd);
quickTitle.name = "title";
quickTitle.placeholder = t.quickAdd;
quickTitle.maxLength = 240;
quickTitle.required = true;
quickTitle.disabled = true;
const quickSubmit = element("button", "↵", "icon-button");
quickSubmit.type = "submit";
quickSubmit.setAttribute("aria-label", t.quickAdd);
quickSubmit.disabled = true;
quickAdd.append(quickTitle, quickSubmit);
let quickPending: { draft: string; board: string; taskId: string } | undefined;
quickAdd.onsubmit = async (event) => {
	event.preventDefault();
	const draft = quickTitle.value;
	if (mutation || !scope || !draft.trim()) return;
	if (quickPending?.board !== scope || quickPending.draft !== draft)
		quickPending = { draft, board: scope, taskId: newTaskId() };
	const { taskId, board } = quickPending;
	const title = contextTitle({ files: [], text: draft }, t.newTask);
	mutation = true;
	quickSubmit.disabled = true;
	try {
		await createTask({ taskId, input: { title } });
		quickPending = undefined;
		if (scope !== board) return;
		if (quickTitle.value === draft) quickTitle.value = "";
		if (selectedFilters.length && !selectedFilters.includes("remaining")) switchList(["remaining"]);
		else await refresh(true);
	} catch {
		notice.textContent = t.error;
	} finally {
		quickSubmit.disabled = false;
		finishMutation();
	}
};
const filters = element("div", undefined, "filter-buttons");
filters.setAttribute("role", "group");
filters.setAttribute("aria-label", t.filter);
const choices = {
	remaining: t.remaining,
	blocked: t.blockedFilter,
	done: t.doneFilter,
};
const filterButtons = Object.entries(choices).map(([key, label]) => {
	const value = key as keyof typeof choices;
	const toggle = button(label, () =>
		switchList(
			selectedFilters.includes(value)
				? selectedFilters.filter((filter) => filter !== value)
				: [...selectedFilters.filter((filter) => filter !== "cancelled"), value],
		),
	);
	toggle.disabled = true;
	toggle.setAttribute("aria-pressed", "false");
	filters.append(toggle);
	return { value, toggle };
});
const cancelledFilter = button(t.cancelled, () =>
	switchList(selectedFilters.includes("cancelled") ? [] : ["cancelled"]),
);
cancelledFilter.hidden = true;
cancelledFilter.setAttribute("aria-pressed", "false");
const more = button(t.more, () => {
	if (next === null) return;
	pageHistory.push(cursor);
	cursor = next;
	resetPage();
});
const previous = button(t.previous, () => {
	cursor = pageHistory.pop() ?? 0;
	resetPage();
});
more.hidden = true;
previous.hidden = true;
const resume = button(t.resume, () => void resumeChat());
resume.hidden = true;
const pageNavigation = group(previous, more);
const filterBar = group(filters, cancelledFilter, resume);
filterBar.classList.add("board-filters");
const heading = group(group(element("h1", t.heading), progressText), add);
heading.classList.add("heading");
const boardHeader = element("header", undefined, "board-header");
boardHeader.append(heading, progressGroup, quickAdd);
const boardList = element("div", undefined, "board-list");
boardList.append(transferNotice, notice, rows, dropZone);
const boardFooter = element("footer", undefined, "board-footer");
boardFooter.append(filterBar, pageNavigation, element("small", `v${manifest.version}`, "meta"));
main.append(boardHeader, boardList, boardFooter);
document.documentElement.lang = locale;
document.body.append(main, dialog);

let selectedFilters: BoardFilter[] = [];
let refreshDiscussion: (() => Promise<void>) | undefined;
let next: number | null = null;
let cursor = 0;
const pageHistory: number[] = [];
type PanelTask = TaskSummary & { titlePending?: boolean };
type PanelBoardList = Omit<BoardList, "tasks"> & { tasks: PanelTask[] };
let current: PanelTask[] = [];
let refreshGeneration = 0;
let refreshing = false;
let mutation = false;
const pendingTransfers: Array<() => Promise<void>> = [];

function finishMutation(): void {
	mutation = false;
	const nextTransfer = pendingTransfers.shift();
	if (nextTransfer) void nextTransfer();
}
let lastRender = "";

function switchList(values: BoardFilter[]): Promise<void> {
	selectedFilters = values;
	for (const { value, toggle } of filterButtons)
		toggle.setAttribute("aria-pressed", String(values.includes(value)));
	cancelledFilter.setAttribute("aria-pressed", String(values.includes("cancelled")));
	cursor = 0;
	pageHistory.length = 0;
	return resetPage();
}

function resetPage(): Promise<void> {
	boardList.scrollTop = 0;
	current = [];
	next = null;
	lastRender = "";
	rows.replaceChildren();
	more.hidden = true;
	previous.hidden = pageHistory.length === 0;
	notice.textContent = t.loading;
	return refresh(true);
}

async function resumeChat(automatic = false): Promise<void> {
	if (resume.disabled) return;
	resume.disabled = true;
	try {
		const board = scope;
		const request = await call<{ requested: boolean }>("request_resume");
		if (!request.requested || scope !== board) return;
		const response = await app.sendMessage(
			{
				role: "user",
				content: [{ type: "text", text: automatic ? t.automaticResumePrompt : t.resumePrompt }],
			},
			{ timeout: 10000, maxTotalTimeout: 10000 },
		);
		if (response.isError) throw new Error("host_rejected");
	} catch {
		notice.textContent = t.error;
	} finally {
		resume.disabled = false;
	}
}

async function refresh(force = false): Promise<void> {
	if (!scope || (refreshing && !force)) return;
	refreshing = true;
	const generation = ++refreshGeneration;
	try {
		const page = await call<PanelBoardList>("list", { after: cursor, filters: selectedFilters });
		if (generation !== refreshGeneration) return;
		current = page.tasks;
		next = page.next;
		render(page.counts);
	} catch {
		if (generation === refreshGeneration) notice.textContent = t.error;
	} finally {
		if (generation === refreshGeneration) refreshing = false;
	}
}

async function revealCreatedTask(task: Task): Promise<void> {
	const loading =
		selectedFilters.length && !selectedFilters.includes("remaining")
			? switchList(["remaining"])
			: refresh(true);
	const generation = refreshGeneration;
	await loading;
	if (generation !== refreshGeneration || dialog.open) return;
	const last = current.at(-1);
	if (next !== null && last && last.ordinal < task.ordinal) {
		pageHistory.push(cursor);
		cursor = task.ordinal - 1;
		await resetPage();
	}
	rows.querySelector(`[data-task-id="${task.id}"]`)?.scrollIntoView({ block: "nearest" });
}

function render(counts: BoardList["counts"]): void {
	const total = counts.queued + counts.running + counts.blocked + counts.done;
	progressGroup.hidden = total === 0;
	progress.max = Math.max(1, total);
	progress.value = counts.done;
	progressText.textContent = total ? `${counts.done}/${total}` : "";
	progressText.setAttribute("aria-label", t.completed({ done: counts.done, total }));
	more.hidden = next === null;
	resume.hidden = counts.queued === 0 || !app.getHostCapabilities()?.message?.text;
	cancelledFilter.hidden = counts.cancelled === 0;
	notice.textContent = current.length
		? ""
		: selectedFilters.length === 0
			? t.empty
			: selectedFilters.length === 1 && selectedFilters[0] === "cancelled"
				? t.emptyCancelled
				: t.emptyFilter;
	const signature = JSON.stringify(
		current.map(({ id, serial, title, titlePending }) => [id, serial, title, titlePending]),
	);
	if (signature === lastRender) return;
	lastRender = signature;
	const focusedTask = rows.contains(document.activeElement) ? dropTaskId(document.activeElement) : undefined;
	rows.replaceChildren(...current.map(renderTask));
	if (focusedTask)
		rows
			.querySelector<HTMLButtonElement>(`[data-task-id="${CSS.escape(focusedTask)}"] .task-title`)
			?.focus({ preventScroll: true });
}

function renderTask(task: PanelTask): HTMLLIElement {
	const row = element("li", undefined, "task");
	row.dataset.testid = `task-row-${task.id}`;
	row.dataset.taskId = task.id;
	row.dataset.state = task.state;
	const markers = { queued: "○", running: "◔", blocked: "!", done: "✓", cancelled: "–" };
	const status =
		task.state === "done"
			? button(markers.done, () => void updateTask("restore", task), "task-marker")
			: element("span", markers[task.state], "task-marker");
	status.dataset.state = task.state;
	if (task.state === "done") {
		status.setAttribute("aria-label", `${t.reopen} · ${task.title}`);
		status.title = t.reopen;
	} else status.setAttribute("aria-hidden", "true");
	const label = t[task.state === "cancelled" ? "cancelledState" : task.state];
	const title = button(task.title, () => void fetchDetails(task.id), "task-title");
	title.setAttribute("aria-label", `${task.title} · ${label}`);
	const summary = element("div", undefined, "task-copy");
	const edit = button("✎", () => void fetchDetails(task.id, true), "icon-button row-edit");
	edit.setAttribute("aria-label", `${t.edit} · ${task.title}`);
	const line = group(title);
	line.classList.add("row-title");
	if (task.state !== "cancelled") line.append(edit);
	summary.append(line);
	const metadata = group(element("span", label, "task-state"));
	metadata.classList.add("task-meta");
	if (task.titlePending) {
		const pending = element("span", t.titlePending, "meta");
		pending.id = `pending-title-${task.id}`;
		title.setAttribute("aria-describedby", pending.id);
		metadata.append(pending);
	}
	const executor = task.assignee === "thread" || task.assignee === "user" ? null : task.assignee;
	metadata.append(element("span", executor ? `${t[task.mode]} → ${executor}` : t[task.mode], "execution"));
	if (task.attachmentCount) {
		const files = element("span", `📎︎ ${task.attachmentCount}`);
		files.setAttribute("aria-label", `${t.attachments} ${task.attachmentCount}`);
		metadata.append(files);
	}
	summary.append(metadata);
	if (task.blockedReason) {
		const blocked = element("div", undefined, "blocker");
		blocked.append(
			element("p", task.blockedReason),
			button(t.resolveBlocker, () => void updateTask("restore", task)),
		);
		summary.append(blocked);
	}
	row.append(status, summary);
	return row;
}

function dialogHeader(title: string, fullPane = false): void {
	refreshDiscussion = undefined;
	dialog.dataset.layout = fullPane ? "pane" : "dialog";
	dialogContent.ondragover = null;
	dialogContent.ondragleave = null;
	dialogContent.ondrop = null;
	dialogContent.onpaste = null;
	dialogContent.classList.remove("drop-armed");
	const heading = element("h2", title);
	heading.id = "task-dialog-title";
	const back = button(
		fullPane ? `‹ ${t.heading}` : "‹",
		() => {
			if (!mutation) dialog.close();
		},
		"icon-button back",
	);
	back.setAttribute("aria-label", t.close);
	if (fullPane) {
		const header = element("header", undefined, "task-detail-header");
		header.append(back, heading);
		dialogContent.replaceChildren(header);
	} else dialogContent.replaceChildren(group(back, heading));
	if (!dialog.open) dialog.showModal();
}

async function fetchDetails(taskId: string, edit = false): Promise<void> {
	dialogHeader(t.loading, !edit);
	const currentHeading = dialogContent.querySelector("h2");
	try {
		const task = await call<Task>("get", { taskId });
		if (dialog.open && currentHeading?.isConnected) {
			if (edit) showEditor(task);
			else showDetails(task);
		}
	} catch {
		if (currentHeading?.isConnected) currentHeading.textContent = t.error;
	}
}

interface DiscussionDraft {
	text: string;
	focused: boolean;
	pending: { body: string; id: string } | undefined;
}

function showDetails(task: Task, draft?: DiscussionDraft): void {
	dialogHeader(task.title, true);
	let readDiscussionDraft: (() => DiscussionDraft) | undefined;
	const detailsState = element(
		"p",
		t[task.state === "cancelled" ? "cancelledState" : task.state],
		"detail-state",
	);
	detailsState.dataset.state = task.state;
	const executor = task.assignee === "thread" || task.manualValidation ? null : task.assignee;
	const metadata = group(
		detailsState,
		element("span", executor ? `${t[task.mode]} → ${executor}` : t[task.mode], "meta"),
	);
	metadata.classList.add("detail-metadata");
	dialogContent.firstElementChild?.append(metadata);
	const mainActions = group();
	mainActions.classList.add("detail-primary-actions");
	if (
		task.state === "queued" ||
		task.state === "blocked" ||
		(task.state === "done" && !task.manualValidation)
	)
		mainActions.append(
			button(t.validate, () => showValidation(task, readDiscussionDraft?.()), "detail-validate"),
		);
	if (task.state === "blocked")
		mainActions.append(button(t.resolveBlocker, () => void updateTask("restore", task)));
	if (mainActions.childElementCount) dialogContent.append(mainActions);
	if (task.body || task.attachments.length) {
		const context = element("details", undefined, "detail-context");
		context.open = task.state !== "done";
		context.append(element("summary", t.currentVersion), renderRevision(task, task, false));
		dialogContent.append(context);
	}
	if (task.receipt && task.state === "done" && !task.verification && task.receipt !== task.manualValidation)
		dialogContent.append(element("p", task.receipt, "notice"));
	if (task.manualValidation) {
		const check = element("section", undefined, "detail-approval");
		check.append(element("h3", t.validatedByYou), element("p", task.manualValidation, "comment-body"));
		dialogContent.append(check);
	}
	if (task.verification) {
		const checks = element("section", undefined, "detail-checks");
		const proof = element("dl", undefined, "verification");
		for (const [label, value] of [
			[t.workPerformed, task.verification.work],
			[t.checkPerformed, task.verification.check],
			[t.checkResult, task.verification.result],
			[t.checkEvidence, task.verification.evidence],
		] as const) {
			proof.append(element("dt", label), element("dd", value));
		}
		checks.append(element("h3", t.codexVerification), proof);
		dialogContent.append(checks);
	}
	const history = element("div", undefined, "stack revision-history");
	history.id = "task-revision-history";
	history.hidden = true;
	const historyToggle = button(t.history, () => {
		history.hidden = !history.hidden;
		historyToggle.setAttribute("aria-expanded", String(!history.hidden));
		if (!history.hidden && !history.hasChildNodes()) void showHistory(task, history);
	});
	historyToggle.setAttribute("aria-expanded", "false");
	historyToggle.setAttribute("aria-controls", history.id);
	const actions = group(historyToggle);
	actions.classList.add("detail-secondary-actions");
	if (task.state === "cancelled") actions.append(button(t.restore, () => void updateTask("restore", task)));
	if (task.state === "done") actions.append(button(t.reopen, () => void updateTask("restore", task)));
	if (task.state === "running") actions.append(button(t.recover, () => confirmRecovery(task)));
	if (task.state !== "cancelled")
		actions.append(
			button(t.edit, () => showEditor(task)),
			button(t.cancelTask, () => void updateTask("cancel", task)),
		);
	if (task.state !== "cancelled") {
		const hint = element("p", t.contextTarget, "drop-zone");
		dialogContent.append(hint);
		installDropSurface(dialogContent, (context) => void saveDroppedContext(context, task.id, true));
		dialogContent.onpaste = (event) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
			if (!event.clipboardData || !acceptsContext(event.clipboardData)) return;
			event.preventDefault();
			const context = captureContext(event.clipboardData);
			if (hasContext(context)) void saveDroppedContext(context, task.id, true);
		};
	}
	dialogContent.append(actions, history);
	readDiscussionDraft = showDiscussion(task, draft);
}

function confirmRecovery(task: Task): void {
	dialogHeader(t.recover);
	dialogContent.append(
		element("p", t.recoverMessage),
		group(
			button(t.recover, () => void updateTask("restore", task)),
			button(t.close, () => showDetails(task)),
		),
	);
}

function showValidation(task: Task, draft?: DiscussionDraft): void {
	dialogHeader(task.title, true);
	const form = element("form", undefined, "detail-validation-form");
	form.setAttribute("aria-labelledby", "task-dialog-title");
	const observation = element("textarea");
	observation.required = true;
	observation.maxLength = 1200;
	const confirm = element("button", t.confirmValidation, "detail-validate");
	confirm.type = "submit";
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const validationEvents = new AbortController();
	function returnToDetail(updated: Task): void {
		validationEvents.abort();
		showDetails(updated, draft);
		const heading = dialogContent.querySelector("h2");
		if (!draft?.focused && heading) {
			heading.tabIndex = -1;
			heading.focus();
		}
	}
	function cancelValidation(event: Event): void {
		if (!form.isConnected) return;
		event.preventDefault();
		if (!mutation) returnToDetail(task);
	}
	dialog.addEventListener("cancel", cancelValidation, { signal: validationEvents.signal });
	dialog.addEventListener("close", () => validationEvents.abort(), {
		once: true,
		signal: validationEvents.signal,
	});
	form.append(element("h3", t.validate));
	if (task.verification)
		form.append(element("p", `${t.checkPerformed} · ${task.verification.check}`, "meta"));
	form.append(
		field(t.manualCheck, observation),
		group(
			confirm,
			button(t.backToDetail, () => {
				if (!mutation) returnToDetail(task);
			}),
		),
		feedback,
	);
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation) return;
		const proof = manualCheck.safeParse(observation.value.trim());
		if (!proof.success) {
			feedback.textContent = t.manualCheck;
			observation.focus();
			return;
		}
		mutation = true;
		confirm.disabled = true;
		try {
			const updated = await call<Task>("validate", {
				taskId: task.id,
				expectedSerial: task.serial,
				observation: proof.data,
			});
			if (dialog.open && form.isConnected) {
				if (draft?.text.trim() || draft?.pending) returnToDetail(updated);
				else {
					validationEvents.abort();
					dialog.close();
					transferMessage(t.taskValidated);
				}
			}
			void refresh(true);
		} catch (error) {
			feedback.textContent = error instanceof Error && error.message === "conflict" ? t.unsigned : t.error;
		} finally {
			confirm.disabled = false;
			finishMutation();
		}
	};
	dialogContent.append(form);
	observation.focus();
}

function showDiscussion(task: Task, savedDraft?: DiscussionDraft): () => DiscussionDraft {
	const section = element("section", undefined, "task-discussion");
	const list = element("ol", undefined, "comment-list");
	const form = element("form");
	const input = element("textarea");
	input.required = true;
	input.maxLength = 8192;
	input.value = savedDraft?.text ?? "";
	const post = element("button", t.postComment, "detail-publish");
	post.type = "submit";
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const readError = element("p", undefined, "notice");
	readError.setAttribute("role", "status");
	const older = button(t.olderComments, () => {
		if (cursor) void load(cursor);
	});
	older.hidden = true;
	const stored = new Map<number, TaskComment>();
	let cursor: number | null = null;
	let loading = false;
	let loaded = false;
	let latestOrdinal: number | undefined;
	let draft = savedDraft?.pending;
	let blocker: TaskComment | undefined;
	function renderComments(): void {
		const entries = [...stored.values(), ...(blocker ? [blocker] : [])].sort(
			(a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal,
		);
		list.replaceChildren(
			...entries.map((comment) => {
				const item = element("li", undefined, "task-comment");
				item.dataset.author = comment.author;
				const timestamp = element("time", dateFormat.format(comment.createdAt), "meta");
				timestamp.dateTime = new Date(comment.createdAt).toISOString();
				const label = comment.kind === "blocker" ? `${t.agent} · ${t.blocked}` : t[comment.author];
				const avatar = element("span", t[comment.author].slice(0, 1), "comment-avatar");
				avatar.setAttribute("aria-hidden", "true");
				const message = element("div", undefined, "comment-message");
				message.append(
					group(element("strong", label), timestamp),
					element("p", comment.body, "comment-body"),
				);
				item.append(avatar, message);
				return item;
			}),
		);
	}
	async function load(before?: number): Promise<void> {
		if (loading || !section.isConnected) return;
		loading = true;
		try {
			const page = await call<CommentsPage & { taskSerial: number }>("comments", { taskId: task.id, before });
			if (page.taskSerial !== task.serial && !post.disabled) {
				const updated = await call<Task>("get", { taskId: task.id });
				if (!dialog.open || !section.isConnected) return;
				const scroll = dialog.scrollTop;
				showDetails(updated, {
					text: input.value,
					focused: document.activeElement === input,
					pending: draft,
				});
				dialog.scrollTop = scroll;
				return;
			}
			const activeBlocker = page.taskSerial === task.serial ? page.currentBlocker : blocker;
			let changed = activeBlocker?.createdAt !== blocker?.createdAt || activeBlocker?.body !== blocker?.body;
			blocker = activeBlocker;
			if (before === undefined) {
				const missedPage =
					page.next !== null && !page.comments.some((comment) => comment.ordinal === latestOrdinal);
				latestOrdinal = page.comments.at(-1)?.ordinal;
				if (missedPage) {
					for (const ordinal of stored.keys()) {
						if (latestOrdinal !== undefined && ordinal <= latestOrdinal) stored.delete(ordinal);
					}
					changed = true;
				}
				if (!loaded || missedPage) cursor = page.next;
			} else cursor = page.next;
			for (const comment of page.comments) {
				if (!stored.has(comment.ordinal)) changed = true;
				stored.set(comment.ordinal, comment);
			}
			loaded = true;
			older.hidden = !cursor;
			if (changed) renderComments();
			readError.textContent = "";
		} catch {
			readError.textContent = t.error;
		} finally {
			loading = false;
		}
	}
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (post.disabled) return;
		const body = commentBody.safeParse(input.value.trim());
		if (!body.success) {
			feedback.textContent = t.addComment;
			return;
		}
		if (draft?.body !== body.data) draft = { body: body.data, id: newTaskId() };
		post.disabled = true;
		input.readOnly = true;
		try {
			await call<TaskComment>("comment", {
				taskId: task.id,
				commentId: draft.id,
				body: draft.body,
			});
			draft = undefined;
			if (section.isConnected && dialog.open) dialog.close();
		} catch {
			feedback.textContent = t.error;
		} finally {
			post.disabled = false;
			input.readOnly = false;
		}
	};
	form.ondragover = (event) => event.stopPropagation();
	form.ondrop = (event) => event.stopPropagation();
	const composerActions = group(post);
	composerActions.classList.add("comment-actions");
	form.append(field(t.addComment, input), composerActions, feedback);
	section.append(element("h3", t.comments), older, list, readError, form);
	dialogContent.append(section);
	if (savedDraft?.focused) input.focus({ preventScroll: true });
	renderComments();
	refreshDiscussion = () => load();
	void load();
	return () => ({ text: input.value, focused: document.activeElement === input, pending: draft });
}

function attachmentView(file: Attachment, open: () => void): HTMLElement {
	return button(file.name, open, "attachment");
}

async function preview(taskId: string, file: Attachment, view: HTMLElement = dialogContent): Promise<void> {
	const status = element("p", t.loading, "notice");
	view.append(status);
	try {
		const content = await call<{ data: string }>("file", { taskId, attachmentId: file.id });
		const bytes = Uint8Array.from(atob(content.data), (value) => value.charCodeAt(0));
		const url = URL.createObjectURL(
			new Blob([bytes], { type: safeImages.has(file.mime) ? file.mime : "application/octet-stream" }),
		);
		dialog.addEventListener("close", () => URL.revokeObjectURL(url), { once: true });
		if (!dialog.open || !status.isConnected) {
			URL.revokeObjectURL(url);
			return;
		}
		if (safeImages.has(file.mime)) {
			const image = element("img");
			image.alt = `${t.preview} · ${file.name}`;
			image.onerror = () => image.replaceWith(element("p", t.missingPreview, "notice"));
			image.src = url;
			status.replaceWith(image);
		} else {
			const link = element("a", file.name);
			link.href = url;
			link.download = file.name;
			status.replaceWith(link);
		}
	} catch {
		status.textContent = t.fileRead;
	}
}

async function showHistory(task: Task, container: HTMLElement, before?: number): Promise<void> {
	const status = element("p", t.loading, "notice");
	container.append(status);
	try {
		const { revisions } = await call<{ revisions: Revision[] }>("history", { taskId: task.id, before });
		if (!status.isConnected) return;
		status.replaceWith(...revisions.map((revision) => renderRevision(task, revision)));
		const last = revisions.at(-1);
		if (last && revisions.length === MAX_PAGE && last.revision > 1) {
			const nextPage = button(t.more, () => {
				nextPage.remove();
				void showHistory(task, container, last.revision);
			});
			container.append(nextPage);
		}
	} catch {
		status.textContent = t.error;
	}
}

function renderRevision(task: Task, revision: Revision, includeTitle = true): HTMLElement {
	const section = element("section", undefined, "revision");
	const label =
		revision.revision === task.revision
			? t.current
			: revision.revision === 1
				? t.initial
				: `v${revision.revision}`;
	if (includeTitle) section.append(element("h3", revision.title));
	section.append(
		element("p", `${label} · ${t[revision.author]} · ${dateFormat.format(revision.createdAt)}`, "meta"),
	);
	if (revision.body) section.append(element("pre", revision.body));
	if (revision.attachments.length)
		section.append(
			group(...revision.attachments.map((file) => attachmentView(file, () => void preview(task.id, file)))),
		);
	return section;
}

async function updateTask(operation: "cancel" | "restore", task: TaskSummary | Task): Promise<void> {
	if (mutation) return;
	mutation = true;
	try {
		await call(operation, { taskId: task.id, expectedSerial: task.serial });
		dialog.close();
		void refresh(true);
	} catch (error) {
		const message = error instanceof Error && error.message === "conflict" ? t.unsigned : t.error;
		if (dialog.open) {
			const errorNotice = element("p", message, "notice");
			errorNotice.setAttribute("role", "status");
			dialogContent.append(errorNotice);
		} else notice.textContent = message;
	} finally {
		finishMutation();
	}
}

function newTaskId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	// An opaque app iframe can still use getRandomValues without a secure origin.
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function showEditor(task?: Task, focusContext = false): void {
	dialogHeader(task ? t.editTask : t.newTask);
	const form = element("form");
	form.setAttribute("aria-labelledby", "task-dialog-title");
	const title = element("input");
	title.name = "title";
	title.required = true;
	title.maxLength = 240;
	title.value = task?.title ?? "";
	const body = element("textarea");
	body.name = "body";
	body.maxLength = 32768;
	body.value = task?.body ?? "";
	const updateTitleRequirement = () => {
		title.required = Boolean(task) || !body.value.trim();
	};
	body.oninput = updateTitleRequirement;
	const mode = element("select");
	mode.name = "mode";
	mode.add(new Option(t.auto, "auto"));
	mode.add(new Option(t.thread, "thread"));
	mode.value = task?.mode ?? "auto";
	const taskId = task?.id ?? newTaskId();
	const save = element("button", t.save, "primary");
	save.type = "submit";
	const status = element("p", undefined, "notice");
	status.setAttribute("role", "status");
	const attachments = makeAttachments(task, status);
	form.append(
		field(t.title, title),
		field(t.detail, body),
		field(t.delegation, mode),
		attachments.section,
		status,
		group(save),
	);
	const addContext = (context: TransferredContext) => {
		if (context.files.length) attachments.addFiles(context.files);
		if (context.text) body.value = appendContextText(body.value, context.text);
		updateTitleRequirement();
	};
	installDropSurface(form, addContext);
	form.onpaste = (event) => {
		if (!event.clipboardData || !acceptsContext(event.clipboardData)) return;
		const context = captureContext(event.clipboardData);
		if (!hasContext(context)) return;
		// Native paste into the editor preserves cursor insertion and the original undo stack.
		if (
			!context.files.length &&
			(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
		)
			return;
		event.preventDefault();
		addContext(context);
	};
	form.onkeydown = (event) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			form.requestSubmit();
		}
	};
	const savingStatus = element("p", undefined, "notice");
	savingStatus.setAttribute("role", "status");
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation) return;
		const board = scope;
		const details = body.value;
		const providedTitle = title.value.trim();
		const resolvedTitle =
			providedTitle || (!task && details.trim() ? contextTitle({ files: [], text: details }, t.newTask) : "");
		if (!resolvedTitle) {
			status.textContent = t.title;
			title.focus();
			return;
		}
		mutation = true;
		save.disabled = true;
		form.inert = true;
		savingStatus.textContent = t.saving;
		status.textContent = "";
		try {
			const input = {
				title: resolvedTitle,
				body: details,
				mode: mode.value,
				keep: attachments.keep(),
				files: await attachments.encode(),
			};
			if (scope !== board || !form.isConnected) return;
			if (task)
				await call("edit", {
					taskId,
					input,
					expectedRevision: task.revision,
					preserveTitle: providedTitle === task.title,
				});
			const added = task
				? undefined
				: await createTask({ taskId, input, ...(!providedTitle ? { generateTitle: locale } : {}) }, true);
			if (scope !== board) return;
			dialog.close();
			if (added) {
				transferMessage(t.taskAdded);
				void revealCreatedTask(added);
				if (added.wake && app.getHostCapabilities()?.message?.text) void resumeChat(true);
			} else void refresh(true);
		} catch (error) {
			const code = error instanceof Error ? error.message : "internal_error";
			status.textContent =
				code === "conflict"
					? t.unsigned
					: ["invalid_attachment", "file_read"].includes(code)
						? t.fileError
						: t.error;
		} finally {
			form.inert = false;
			savingStatus.textContent = "";
			save.disabled = false;
			finishMutation();
		}
	};
	dialogContent.append(savingStatus, form);
	(!task || focusContext ? body : title).focus();
	const droppedImage =
		focusContext && task ? task.attachments.find((file) => safeImages.has(file.mime)) : undefined;
	if (task && droppedImage) void preview(task.id, droppedImage, attachments.section);
}

function makeAttachments(task: Task | undefined, status: HTMLElement) {
	let existing = [...(task?.attachments ?? [])];
	let selected: File[] = [];
	const section = element("fieldset");
	const picker = element("input");
	picker.type = "file";
	picker.name = "files";
	picker.multiple = true;
	const previews = element("div", undefined, "stack");
	const refreshPreviews = () =>
		previews.replaceChildren(
			...existing.map((file) =>
				group(
					element("span", file.name),
					button(t.remove, () => {
						existing = existing.filter((current) => current !== file);
						refreshPreviews();
					}),
				),
			),
			...selected.map((file) =>
				group(
					element("span", file.name),
					button(t.remove, () => {
						selected = selected.filter((current) => current !== file);
						refreshPreviews();
					}),
				),
			),
		);
	const addFiles = (files: readonly File[]) => {
		const merged = [...selected, ...files];
		try {
			validateFiles(merged, existing.length);
		} catch {
			status.textContent = t.fileError;
			return;
		}
		selected = merged;
		status.textContent = "";
		refreshPreviews();
	};
	picker.onchange = () => {
		addFiles([...(picker.files ?? [])]);
		picker.value = "";
	};
	const browse = button(t.upload, () => picker.click(), "browse");
	picker.hidden = true;
	section.append(
		element("legend", t.attachments),
		element("p", t.contextTarget, "drop-zone"),
		previews,
		browse,
		picker,
	);
	refreshPreviews();
	return {
		section,
		addFiles,
		keep: () => existing.map((file) => file.id),
		encode: () => encodeFiles(selected, existing.length),
	};
}

/** Installs a drop target whose hint follows drag enter/leave without tracking the pointer. */
function installDropSurface(
	target: HTMLElement,
	receive: (context: TransferredContext, event: DragEvent) => void,
): void {
	const clear = () => target.classList.remove("drop-armed");
	target.ondragover = (event) => {
		if (!scope || !acceptsContext(event.dataTransfer)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		target.classList.add("drop-armed");
	};
	target.ondragleave = (event) => {
		if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) clear();
	};
	target.ondrop = (event) => {
		clear();
		if (!scope || !event.dataTransfer || !acceptsContext(event.dataTransfer)) return;
		event.preventDefault();
		event.stopPropagation();
		const context = captureContext(event.dataTransfer);
		if (hasContext(context)) receive(context, event);
	};
}

function dropTaskId(target: EventTarget | null): string | undefined {
	return target instanceof Element
		? target.closest<HTMLElement>("[data-task-id]")?.dataset.taskId
		: undefined;
}

function transferMessage(message: string, retry?: () => void): void {
	transferNotice.replaceChildren(element("span", message));
	if (retry) transferNotice.append(button(t.retry, retry));
}

/** Commits a captured drop once and reuses the same request after a transport error. */
async function saveDroppedContext(
	context: TransferredContext,
	taskId?: string,
	fromDetail = false,
): Promise<void> {
	if (!scope) return;
	if (taskId && current.find((task) => task.id === taskId)?.state === "cancelled") {
		transferMessage(t.invalidTarget);
		return;
	}
	const board = scope;
	const detailView = fromDetail ? dialogContent.firstElementChild : null;
	const stillShowingDetail = () =>
		!!detailView && dialog.open && dialogContent.firstElementChild === detailView;
	const newId = taskId ?? newTaskId();
	let command: Record<string, unknown> | undefined;
	const save = async () => {
		if (scope !== board) {
			finishMutation();
			return;
		}
		if (mutation) {
			pendingTransfers.push(save);
			transferMessage(t.contextQueued);
			return;
		}
		mutation = true;
		transferMessage(t.saving);
		try {
			if (!command) {
				const task = taskId ? await call<Task>("get", { taskId }) : undefined;
				const keep = task?.attachments.map(({ id }) => id) ?? [];
				command = {
					taskId: newId,
					...(task ? { expectedRevision: task.revision, preserveTitle: true } : {}),
					input: {
						title: task?.title ?? contextTitle(context, t.newTask),
						body: appendContextText(task?.body ?? "", context.text),
						mode: task?.mode ?? "auto",
						keep,
						files: await encodeFiles(context.files, keep.length),
					},
				};
			}
			if (scope !== board) return;
			const saved = taskId ? await call<Task>("edit", command) : await createTask(command, true);
			if (scope !== board) return;
			transferMessage(taskId ? t.contextAdded : t.taskAdded);
			if (!taskId) {
				switchList([]);
				openDropEditor(saved, board, "wake" in saved && saved.wake === true);
			} else {
				if (stillShowingDetail()) {
					showDetails(saved);
					dialogContent.append(element("p", t.contextAdded, "notice"));
				}
				void refresh(true);
			}
		} catch (error) {
			const code = error instanceof Error ? error.message : "internal_error";
			const message =
				code === "conflict" ? t.unsigned : code === "invalid_attachment" ? t.fileError : t.contextError;
			const retry = code === "conflict" || code === "invalid_attachment" ? undefined : () => void save();
			transferMessage(message, retry);
			if (stillShowingDetail())
				dialogContent.append(element("p", message, "notice"), ...(retry ? [button(t.retry, retry)] : []));
		} finally {
			finishMutation();
		}
	};
	await save();
}

function openDropEditor(task: Task, board: string, wake: boolean): void {
	if (scope !== board) return;
	if (dialog.open) {
		dialog.addEventListener("close", () => openDropEditor(task, board, wake), { once: true });
		return;
	}
	showEditor(task, true);
	if (wake) {
		dialog.addEventListener(
			"close",
			async () => {
				if (scope !== board || !app.getHostCapabilities()?.message?.text) return;
				try {
					const result = await call<{ wake: boolean }>("can_resume", { taskId: task.id });
					if (result.wake && scope === board) void resumeChat(true);
				} catch {
					// The saved task remains available for manual resumption.
				}
			},
			{ once: true },
		);
	}
}

installDropSurface(main, (context) => void saveDroppedContext(context));
document.addEventListener("paste", (event) => {
	if (!scope || dialog.open || !event.clipboardData || !acceptsContext(event.clipboardData)) return;
	if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
	const context = captureContext(event.clipboardData);
	if (!hasContext(context)) return;
	event.preventDefault();
	void saveDroppedContext(context, dropTaskId(event.target));
});

app.ontoolresult = (result) => {
	const binding = id.safeParse(result._meta?.binding);
	if (!binding.success || scope === binding.data) return;
	scope = binding.data;
	dialog.close();
	add.disabled = false;
	quickTitle.disabled = false;
	quickSubmit.disabled = false;
	for (const { toggle } of filterButtons) toggle.disabled = false;
	switchList([]);
};
function updateHostStyle(context?: McpUiHostContext): void {
	if (context?.theme) applyDocumentTheme(context.theme);
	if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.onhostcontextchanged = updateHostStyle;
try {
	await app.connect();
	updateHostStyle(app.getHostContext());
	if (!scope) notice.textContent = t.connect;
} catch {
	notice.textContent = t.error;
}
const timer = window.setInterval(() => {
	if (document.hidden || mutation) return;
	if (dialog.open) void refreshDiscussion?.();
	else void refresh();
}, POLL_MS);
window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
