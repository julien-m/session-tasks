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
	captureContext,
	contextTitle,
	encodeFiles,
	hasContext,
	type TransferredContext,
	validateFiles,
} from "./context-transfer.ts";
import {
	type Attachment,
	appendContextText,
	type BoardFilter,
	boardInstructionsBody,
	byteLength,
	commentBody,
	type InstructionEntryWrite,
	type InstructionProject,
	id,
	instructionEntryWrite,
	MAX_BOARD_INSTRUCTIONS_BYTES,
	MAX_PAGE,
	MAX_TASK_BODY_BYTES,
	manualCheck,
	type PresentedInstruction,
	type Reformulation,
	type Revision,
	resumeCodePrefix,
	type Task,
	type TaskComment,
	type TaskSummary,
	taskInput,
} from "./contract.ts";
import { renderMarkdown } from "./markdown-view.ts";
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

function taskSubmit(text: string, className: string): HTMLButtonElement {
	const control = element("button", text, className);
	control.type = "submit";
	control.dataset.taskSubmit = "";
	control.setAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
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

function updateMarkdown(content: HTMLElement, source: string): void {
	renderMarkdown(content, source, (url) => {
		void app.openLink({ url }).catch(() => {});
	});
}

function markdownBlock(source: string, className = "markdown-content"): HTMLDivElement {
	const content = element("div", undefined, className);
	updateMarkdown(content, source);
	return content;
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
progressGroup.append(progress, progressText);
progressGroup.hidden = true;
const notice = element("p", t.loading, "notice");
notice.setAttribute("role", "status");
const rows = element("ul", undefined, "rows");
const transferNotice = element("div", undefined, "group transfer-notice");
transferNotice.setAttribute("role", "status");
const dropZone = element("p", t.dropHere, "drop-zone");
main.tabIndex = 0;
const dialog = element("dialog");
let returnToPreviousView: (() => void) | undefined;
function goBackInPanel(): void {
	if (mutation) return;
	if (returnToPreviousView) returnToPreviousView();
	else dialog.close();
}

dialog.addEventListener("cancel", (event) => {
	event.preventDefault();
	goBackInPanel();
});
window.addEventListener(
	"keydown",
	(event) => {
		if (!dialog.open || event.defaultPrevented || event.isComposing || event.repeat) return;
		const editable =
			event.target instanceof HTMLElement &&
			(event.target.matches("input, textarea, select") || event.target.isContentEditable);
		const back =
			event.key === "BrowserBack" ||
			(event.metaKey && !event.altKey && event.key === "[") ||
			(event.altKey && !event.metaKey && !editable && event.key === "ArrowLeft");
		if (!back || event.shiftKey || event.ctrlKey) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		goBackInPanel();
	},
	{ capture: true },
);
window.addEventListener(
	"auxclick",
	(event) => {
		if (!dialog.open || event.button !== 3) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		goBackInPanel();
	},
	{ capture: true },
);
dialog.addEventListener("keydown", (event) => {
	if (
		event.defaultPrevented ||
		event.key !== "Enter" ||
		!(event.metaKey || event.ctrlKey) ||
		event.altKey ||
		event.shiftKey ||
		event.isComposing
	)
		return;
	const submit = dialog.querySelector<HTMLButtonElement>("button[data-task-submit]");
	if (!submit?.form || !dialog.open) return;
	event.preventDefault();
	if (!event.repeat && !mutation && !submit.disabled) submit.form.requestSubmit(submit);
});
dialog.setAttribute("aria-labelledby", "task-dialog-title");
const dialogContent = element("div", undefined, "dialog-content");
const detailFooter = element("footer", undefined, "group detail-footer comment-actions");
detailFooter.hidden = true;
dialog.append(dialogContent, detailFooter);
const add = button("+", () => showEditor(), "icon-button");
add.setAttribute("aria-label", t.add);
add.title = t.add;
add.disabled = true;
const quickAdd = element("form", undefined, "quick-add");
const quickTitle = element("input");
quickTitle.setAttribute("aria-label", t.quickAdd);
quickTitle.name = "title";
quickTitle.placeholder = t.quickAdd;
quickTitle.required = true;
quickTitle.disabled = true;
const quickSubmit = element("button", "↵", "icon-button");
quickSubmit.type = "submit";
quickSubmit.setAttribute("aria-label", t.quickAdd);
quickSubmit.disabled = true;
quickAdd.append(quickTitle, quickSubmit);
function titleOnlyInput(text: string): { title: string; body: string } {
	const title = contextTitle({ files: [], text }, t.newTask);
	return { title, body: text.trim() === title ? "" : text };
}

let quickPending: { draft: string; board: string; taskId: string } | undefined;
quickAdd.onsubmit = async (event) => {
	event.preventDefault();
	const draft = quickTitle.value;
	if (mutation || !scope || !draft.trim()) return;
	if (draft.length > MAX_TASK_BODY_BYTES || byteLength(draft) > MAX_TASK_BODY_BYTES) {
		transferMessage(t.taskTextTooLong);
		return;
	}
	if (quickPending?.board !== scope || quickPending.draft !== draft)
		quickPending = { draft, board: scope, taskId: newTaskId() };
	const { taskId, board } = quickPending;
	const input = titleOnlyInput(draft);
	mutation = true;
	quickSubmit.disabled = true;
	try {
		const saved = await createTask({ taskId, input, reformulate: locale });
		quickPending = undefined;
		if (scope !== board) return;
		if (quickTitle.value === draft) quickTitle.value = "";
		void revealCreatedTask(saved);
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
const boardHeader = element("header", undefined, "board-header");
const taskTab = button(t.heading, () => selectBoardTab(false));
const instructionTab = button(t.instructions, () => selectBoardTab(true));
const tabList = group(taskTab, instructionTab);
tabList.classList.add("board-tabs");
tabList.setAttribute("role", "tablist");
tabList.setAttribute("aria-label", t.boardViews);
for (const [index, tab] of [taskTab, instructionTab].entries()) {
	tab.id = index ? "tab-instructions" : "tab-tasks";
	tab.setAttribute("role", "tab");
	tab.setAttribute("aria-selected", String(index === 0));
	tab.tabIndex = index === 0 ? 0 : -1;
	tab.onkeydown = (event) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const selectInstructions = event.key === "End" || (event.key !== "Home" && index === 0);
		selectBoardTab(selectInstructions);
		(selectInstructions ? instructionTab : taskTab).focus();
	};
}
boardHeader.append(tabList);
const boardList = element("div", undefined, "board-list");
boardList.append(transferNotice, notice, rows, dropZone);
const addRow = element("div", undefined, "board-add");
addRow.append(quickAdd, add);
const boardFooter = element("footer", undefined, "board-footer");
boardFooter.append(
	filterBar,
	pageNavigation,
	element("small", `v${manifest.version}`, "meta"),
	progressGroup,
	addRow,
);
const taskPanel = element("section", undefined, "board-tab-panel");
const instructionPanel = element("section", undefined, "board-tab-panel");
for (const [panel, tab] of [
	[taskPanel, taskTab],
	[instructionPanel, instructionTab],
] as const) {
	panel.setAttribute("role", "tabpanel");
	panel.setAttribute("aria-labelledby", tab.id);
}
const instructionList = element("ul", undefined, "rows");
const instructionNotice = element("p", t.loading, "notice");
instructionNotice.setAttribute("role", "status");
const instructionScroll = element("div", undefined, "board-list");
instructionScroll.append(instructionNotice, instructionList);
const instructionAdd = button(
	"+",
	() => showInstructionEditor(undefined, { text: quickInstruction.value, files: [] }),
	"icon-button",
);
instructionAdd.disabled = true;
instructionAdd.setAttribute("aria-label", t.addInstruction);
instructionAdd.title = t.addInstruction;
const instructionQuickForm = element("form", undefined, "quick-add");
const quickInstruction = element("input");
quickInstruction.setAttribute("aria-label", t.quickInstruction);
quickInstruction.placeholder = t.quickInstruction;
quickInstruction.required = true;
const quickInstructionSubmit = element("button", "↵", "icon-button");
quickInstructionSubmit.type = "submit";
quickInstructionSubmit.setAttribute("aria-label", t.quickInstruction);
instructionQuickForm.append(quickInstruction, quickInstructionSubmit);
let unsavedInstruction: { scope: string; draft: string; entryId: string } | undefined;
instructionQuickForm.onsubmit = async (event) => {
	event.preventDefault();
	const draft = quickInstruction.value;
	if (!scope || mutation || !draft.trim()) return;
	if (unsavedInstruction?.scope !== scope || unsavedInstruction.draft !== draft)
		unsavedInstruction = { scope, draft, entryId: newTaskId() };
	const command = instructionEntryWrite.safeParse({
		entryId: unsavedInstruction.entryId,
		expectedRevision: 0,
		body: draft,
		permanent: false,
	});
	if (!command.success) {
		instructionNotice.textContent = t.instructionsLimit;
		return;
	}
	const board = scope;
	mutation = true;
	quickInstructionSubmit.disabled = true;
	try {
		await saveInstruction(command.data);
		unsavedInstruction = undefined;
		if (scope === board && quickInstruction.value === draft) quickInstruction.value = "";
		void refreshInstructions();
	} catch {
		if (scope === board) instructionNotice.textContent = t.error;
	} finally {
		quickInstructionSubmit.disabled = false;
		finishMutation();
	}
};
const instructionFooter = element("footer", undefined, "board-footer");
const instructionAddRow = element("div", undefined, "board-add");
instructionAddRow.append(instructionQuickForm, instructionAdd);
instructionFooter.append(element("small", `v${manifest.version}`, "meta"), instructionAddRow);
taskPanel.append(boardList, boardFooter);
instructionPanel.append(instructionScroll, instructionFooter);
instructionPanel.hidden = true;
main.append(boardHeader, taskPanel, instructionPanel);
document.documentElement.lang = locale;
document.body.append(main, dialog);

let selectedFilters: BoardFilter[] = [];
let refreshDiscussion: (() => Promise<void>) | undefined;
let next: number | null = null;
let cursor = 0;
const pageHistory: number[] = [];
type PanelTask = BoardList["tasks"][number] & { titlePending?: boolean };
type PanelDetail = Task & { reformulation?: Reformulation; reformulationPending?: boolean };
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
let draggedTask: PanelTask | undefined;

function moveTask(source: PanelTask, target: PanelTask): void {
	if (mutation || source.id === target.id || target.state !== "queued") return;
	void (async () => {
		mutation = true;
		try {
			await call("move", {
				taskId: source.id,
				targetId: target.id,
				position: source.position,
				targetPosition: target.position,
			});
			transferMessage(t.taskMoved);
		} catch (error) {
			transferMessage(error instanceof Error && error.message === "conflict" ? t.unsigned : t.error);
		} finally {
			void refresh(true);
			finishMutation();
		}
	})();
}

function taskReorderHandle(task: PanelTask, row: HTMLLIElement): HTMLButtonElement {
	const grip = element("button", "⠿", "icon-button reorder-handle");
	grip.type = "button";
	grip.title = t.reorderHint;
	grip.setAttribute("aria-label", `${t.reorderTask} · ${task.title}`);
	grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");

	function neighbor(offset: number): PanelTask | undefined {
		const queued = current.filter((entry) => entry.state === "queued");
		return queued[queued.findIndex((entry) => entry.id === task.id) + offset];
	}
	function selectNeighbor(offset: number): void {
		const target = neighbor(offset);
		if (target) moveTask(task, target);
	}
	grip.onkeydown = (event) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		selectNeighbor(event.key === "ArrowUp" ? -1 : 1);
	};

	let start: { id: number; x: number; y: number } | undefined;
	let targetRow: HTMLElement | undefined;
	let skipClick = false;
	grip.onpointerdown = (event) => {
		if (!event.isPrimary || event.button !== 0 || mutation) return;
		start = { id: event.pointerId, x: event.clientX, y: event.clientY };
		skipClick = false;
		grip.setPointerCapture(event.pointerId);
	};
	grip.onpointermove = (event) => {
		if (!start || event.pointerId !== start.id) return;
		if (!draggedTask && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
		draggedTask = task;
		row.classList.add("reorder-source");
		const candidate = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>(".task[data-state=queued]");
		const next = candidate && candidate !== row && rows.contains(candidate) ? candidate : undefined;
		if (next === targetRow) return;
		targetRow?.classList.remove("reorder-target");
		targetRow = next;
		targetRow?.classList.add("reorder-target");
	};
	function endDrag(event: PointerEvent, commit: boolean): void {
		if (!start || start.id !== event.pointerId) return;
		const destination = targetRow?.dataset.taskId;
		const active = draggedTask?.id === task.id;
		start = undefined;
		draggedTask = undefined;
		skipClick = active;
		row.classList.remove("reorder-source");
		targetRow?.classList.remove("reorder-target");
		targetRow = undefined;
		if (!commit || !active || !destination) return;
		const target = current.find((entry) => entry.id === destination);
		if (target) moveTask(task, target);
	}
	grip.onpointerup = (event) => endDrag(event, true);
	grip.onpointercancel = (event) => endDrag(event, false);
	grip.onlostpointercapture = (event) => endDrag(event, false);
	grip.onclick = (event) => {
		if (event.detail > 0 && skipClick) {
			skipClick = false;
			return;
		}
		dialogHeader(t.reorderTask);
		const move = (offset: number) => {
			dialog.close();
			selectNeighbor(offset);
		};
		const up = button(t.moveUp, () => move(-1));
		const down = button(t.moveDown, () => move(1));
		up.disabled = !neighbor(-1);
		down.disabled = !neighbor(1);
		dialogContent.append(element("p", task.title), group(up, down));
	};
	return grip;
}

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
		const request = await call<{ requested: boolean; code?: string }>("request_resume");
		if (!request.requested || !request.code || scope !== board) return;
		const prompt = automatic ? t.automaticResumePrompt : t.resumePrompt;
		const response = await app.sendMessage(
			{
				role: "user",
				content: [{ type: "text", text: `${prompt}\n\n${resumeCodePrefix}${request.code}` }],
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
	if (next !== null && last && last.position < task.ordinal) {
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
	taskTab.textContent = total ? `${t.heading} ${total}` : t.heading;
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
	if (signature === lastRender || draggedTask) return;
	lastRender = signature;
	const active = document.activeElement;
	const focusedTask = rows.contains(active) ? dropTaskId(active) : undefined;
	const focusClass =
		["reorder-handle", "row-edit", "task-marker", "task-title"].find((name) =>
			active?.classList.contains(name),
		) ?? "task-title";
	rows.replaceChildren(...current.map(renderTask));
	if (focusedTask)
		rows
			.querySelector<HTMLButtonElement>(`[data-task-id="${CSS.escape(focusedTask)}"] .${focusClass}`)
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
	if (task.state === "queued" && current.filter((entry) => entry.state === "queued").length > 1) {
		const grip = taskReorderHandle(task, row);
		line.append(grip);
	}
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

function dialogHeader(title: string, fullPane = false, instructionEditor = false): void {
	returnToPreviousView = undefined;
	refreshDiscussion = undefined;
	detailFooter.hidden = true;
	detailFooter.replaceChildren();
	dialog.dataset.layout = fullPane ? "pane" : instructionEditor ? "instruction" : "dialog";
	dialogContent.ondragover = null;
	dialogContent.ondragleave = null;
	dialogContent.ondrop = null;
	dialogContent.onpaste = null;
	dialogContent.classList.remove("drop-armed");
	const heading = element("h2", title);
	heading.id = "task-dialog-title";
	const back = button(
		fullPane || instructionEditor ? `‹ ${instructionPanel.hidden ? t.heading : t.instructions}` : "‹",
		goBackInPanel,
		"icon-button back",
	);
	back.setAttribute("aria-label", t.close);
	if (fullPane || instructionEditor) {
		const header = element("header", undefined, "task-detail-header");
		header.append(back, heading);
		dialogContent.replaceChildren(header);
	} else dialogContent.replaceChildren(group(back, heading));
	if (!dialog.open) dialog.showModal();
	else back.focus();
}

let instructionRequest = 0;
let instructionSignature = "";
let deferredInstruction: string | undefined;
let instructionProjects: InstructionProject[] = [];

function instructionScopeName(entry: PresentedInstruction): string {
	if (entry.projectId)
		return (
			instructionProjects.find((project) => project.id === entry.projectId)?.name ?? t.instructionProject
		);
	return entry.permanent ? t.instructionsAllChats : t.instructionsThisChat;
}

async function saveInstruction(entry: InstructionEntryWrite): Promise<void> {
	const board = scope;
	const saved = await call<{ entryId: string; deferred?: boolean }>("save_instruction_entry", {
		entry,
		reformulate: locale,
		manageProjects: true,
	});
	if (scope !== board) return;
	if (saved.deferred) deferredInstruction = saved.entryId;
	else if (deferredInstruction === saved.entryId || deferredInstruction === entry.entryId)
		deferredInstruction = undefined;
}

async function refreshInstructionProjects(): Promise<void> {
	const board = scope;
	try {
		const { projects } = await call<{ projects: InstructionProject[] }>("instruction_projects");
		if (scope === board) instructionProjects = projects;
	} catch {
		if (scope === board) instructionProjects = [];
	}
}

function selectBoardTab(showInstructions: boolean): void {
	const changed = instructionPanel.hidden === showInstructions;
	instructionPanel.hidden = !showInstructions;
	taskPanel.hidden = showInstructions;
	taskTab.tabIndex = showInstructions ? -1 : 0;
	instructionTab.tabIndex = showInstructions ? 0 : -1;
	taskTab.setAttribute("aria-selected", String(!showInstructions));
	instructionTab.setAttribute("aria-selected", String(showInstructions));
	if (!changed) return;
	if (showInstructions) void refreshInstructionProjects().then(refreshInstructions);
	else void refresh(true);
}

function instructionTitle(entry: PresentedInstruction): string {
	const firstLine = entry.body.split(/\r?\n/u).find((line) => line.trim()) ?? "";
	const title =
		entry.reformulation?.title ?? (markdownBlock(firstLine.trim()).textContent?.trim() || t.instruction);
	const characters = Array.from(title);
	return characters.length > 96 ? `${characters.slice(0, 96).join("")}…` : title;
}

async function refreshInstructions(): Promise<void> {
	if (!scope || instructionPanel.hidden) return;
	const board = scope;
	const generation = ++instructionRequest;
	try {
		const { instructions } = await call<{ instructions: PresentedInstruction[] }>("instruction_entries", {
			manageProjects: true,
		});
		if (scope !== board || generation !== instructionRequest) return;
		if (
			deferredInstruction &&
			!instructions.some(
				(entry) => entry.id === deferredInstruction && !entry.reformulation && !entry.reformulationPending,
			)
		)
			deferredInstruction = undefined;
		instructionNotice.textContent = deferredInstruction
			? t.instructionModelBusy
			: instructions.length
				? ""
				: t.instructionsEmpty;
		instructionTab.textContent = instructions.length
			? `${t.instructions} ${instructions.length}`
			: t.instructions;
		const signature = JSON.stringify([instructions, instructionProjects]);
		if (signature === instructionSignature) return;
		instructionSignature = signature;
		const active = document.activeElement?.closest<HTMLElement>("[data-instruction-id]");
		const action =
			document.activeElement instanceof HTMLElement
				? document.activeElement.dataset.instructionAction
				: undefined;
		instructionList.replaceChildren(
			...instructions.map((entry) => {
				const title = entry.reformulationPending ? t.instructionTitlePending : instructionTitle(entry);
				const row = element("li", undefined, "task instruction-row");
				row.dataset.instructionId = entry.id;
				const icon = element("span", "≡", "instruction-icon");
				icon.setAttribute("aria-hidden", "true");
				const edit = button("✎", () => showInstructionEditor(entry), "icon-button row-edit");
				edit.setAttribute("aria-label", `${t.edit} · ${title}`);
				edit.dataset.instructionAction = "edit";
				const toggle = button(title, () => showInstructionDetails(entry), "task-title");
				toggle.dataset.instructionAction = "toggle";
				const line = group(toggle, edit);
				line.classList.add("row-title");
				const copy = element("div", undefined, "task-copy");
				copy.append(line, element("span", instructionScopeName(entry), "meta"));
				if (entry.reformulationFailed) copy.append(element("small", t.instructionModelFailed, "meta"));
				row.append(icon, copy);
				return row;
			}),
		);
		if (active?.dataset.instructionId) {
			instructionList
				.querySelector<HTMLElement>(
					`[data-instruction-id="${CSS.escape(active.dataset.instructionId)}"] [data-instruction-action="${action ?? "toggle"}"]`,
				)
				?.focus({ preventScroll: true });
		}
	} catch {
		if (scope === board && generation === instructionRequest) instructionNotice.textContent = t.error;
	}
}

function showInstructionDetails(entry: PresentedInstruction): void {
	dialogHeader(instructionTitle(entry), false, true);
	const content = element("section", undefined, "instruction-reading");
	content.append(element("h3", t.instructionContent), markdownBlock(entry.reformulation?.body ?? entry.body));
	dialogContent.append(element("p", instructionScopeName(entry), "meta"), content);
	if (entry.reformulation) {
		const original = element("details", undefined, "revision-original");
		original.append(element("summary", t.originalText), element("pre", entry.body));
		dialogContent.append(original);
	}
	dialogContent.append(
		group(
			button(t.edit, () => {
				showInstructionEditor(entry);
				returnToPreviousView = () => showInstructionDetails(entry);
			}),
			button(t.remove, () => confirmInstructionRemoval(entry)),
		),
	);
}

function confirmInstructionRemoval(entry: PresentedInstruction): void {
	dialogHeader(t.removeInstruction);
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const confirm = button(t.remove, () => void remove(), "primary");
	async function remove(): Promise<void> {
		if (mutation) return;
		const board = scope;
		mutation = true;
		confirm.disabled = true;
		try {
			await call("remove_instruction_entry", {
				entryId: entry.id,
				expectedRevision: entry.revision,
				manageProjects: true,
			});
			if (scope === board) {
				dialog.close();
				void refreshInstructions();
			}
		} catch (error) {
			feedback.textContent =
				error instanceof Error && error.message === "conflict" ? t.instructionsConflict : t.error;
		} finally {
			confirm.disabled = false;
			finishMutation();
		}
	}
	dialogContent.append(element("p", instructionTitle(entry)), group(confirm), feedback);
}

function showInstructionEditor(entry?: PresentedInstruction, initialContext?: TransferredContext): void {
	dialogHeader(entry ? t.editInstruction : t.addInstruction, false, true);
	const form = element("form");
	form.setAttribute("aria-labelledby", "task-dialog-title");
	const input = element("textarea");
	input.name = "instruction";
	input.required = true;
	input.maxLength = MAX_BOARD_INSTRUCTIONS_BYTES;
	input.rows = 6;
	input.value = entry?.body ?? "";
	let source = { displayed: input.value, body: entry?.body ?? "" };
	const readDraft = () => (input.value === source.displayed ? source.body : input.value);
	const choices = element("fieldset", undefined, "instruction-audience");
	const segments = element("div", undefined, "instruction-segments");
	choices.append(element("legend", t.instructionScope), segments);
	const audience = entry?.projectId ? "project" : entry?.permanent ? "all" : "chat";
	for (const [value, caption] of [
		["chat", t.instructionsThisChat],
		["all", t.instructionsAllChats],
		["project", t.instructionProjectOption],
	] as const) {
		const option = element("input");
		option.type = "radio";
		option.name = "audience";
		option.value = value;
		option.checked = audience === value;
		const label = element("label");
		label.append(option, element("span", caption));
		segments.append(label);
	}
	const scopeHint = element("p", undefined, "instruction-hint");
	scopeHint.id = "instruction-scope-hint";
	choices.setAttribute("aria-describedby", scopeHint.id);
	const projectField = element("fieldset", undefined, "instruction-project");
	const projectRows = element("div", undefined, "instruction-project-rows");
	projectField.append(element("legend", t.instructionProject), projectRows);
	const projectStatus = element("p", t.noInstructionProjects, "instruction-project-empty");
	projectStatus.setAttribute("role", "status");
	const target = element("div", undefined, "instruction-scope");
	target.append(choices, scopeHint, projectField, projectStatus);
	const save = taskSubmit(t.save, "primary");
	let importing = false;
	let selectedProject = entry?.projectId ?? "";
	const selectedAudience = () => new FormData(form).get("audience") ?? audience;
	const updateProjectField = () => {
		const scope = selectedAudience();
		const active = scope === "project";
		const available = projectRows.hasChildNodes();
		projectField.hidden = !(active && available);
		projectField.disabled = !active;
		projectStatus.hidden = !active || available;
		scopeHint.textContent =
			scope === "chat"
				? t.instructionScopeChat
				: scope === "all"
					? t.instructionScopeAll
					: t.instructionScopeProject;
		save.disabled = importing || form.inert || (active && !projectRows.querySelector(":checked"));
	};
	const fillProjects = () => {
		if (projectRows.contains(document.activeElement)) return;
		projectRows.replaceChildren(
			...instructionProjects.map(({ id, name, chatCount }) => {
				const option = element("input");
				option.type = "radio";
				option.name = "project";
				option.value = id;
				option.checked = id === selectedProject;
				option.onchange = () => {
					selectedProject = option.value;
					updateProjectField();
				};
				const label = element("label", undefined, "instruction-project-row");
				const check = element("span", "✓", "instruction-project-check");
				check.setAttribute("aria-hidden", "true");
				const title = element("span", name, "instruction-project-name");
				label.append(option, check, title);
				if (chatCount !== undefined)
					label.append(element("span", t.instructionProjectChats(chatCount), "instruction-project-count"));
				return label;
			}),
		);
		updateProjectField();
	};
	choices.onchange = updateProjectField;
	void refreshInstructionProjects().then(() => {
		if (form.isConnected) fillProjects();
	});
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const cancel = button(t.cancelInstructionEdit, goBackInPanel);
	const textHint = element(
		"p",
		`${t.instructionTextImport} ${t.instructionGeneratedHelp}`,
		"instruction-hint",
	);
	textHint.id = "instruction-text-import";
	input.setAttribute("aria-describedby", textHint.id);
	const textField = element("div", undefined, "instruction-text-field");
	const editorField = field(t.instruction, input);
	if (entry)
		editorField.insertBefore(
			element("span", t.instructionCurrentTitle(instructionTitle(entry)), "instruction-hint"),
			input,
		);
	textField.append(editorField, textHint, feedback);
	const buttons = group(cancel, save);
	buttons.classList.add("instruction-actions");
	const actions = element("div", undefined, "instruction-footer");
	if (entry) actions.append(button(t.remove, () => confirmInstructionRemoval(entry)));
	actions.append(buttons);
	form.append(textField, target, actions);
	dialogContent.append(form);
	fillProjects();
	input.focus();
	const entryId = entry?.id ?? newTaskId();
	async function addText(context: TransferredContext): Promise<void> {
		if (mutation || importing) return;
		importing = true;
		save.disabled = true;
		try {
			const [file] = context.files;
			let text = context.text;
			if (file) {
				if (
					context.files.length !== 1 ||
					file.size > MAX_BOARD_INSTRUCTIONS_BYTES ||
					!(/\.(txt|md|markdown)$/iu.test(file.name) || /^text\/(plain|markdown)$/iu.test(file.type))
				) {
					feedback.textContent = t.instructionFileError;
					return;
				}
				text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
				if (text.includes("\0")) {
					feedback.textContent = t.instructionFileError;
					return;
				}
			}
			if (!form.isConnected || !dialog.open) return;
			const appended = appendContextText(readDraft(), text);
			if (!boardInstructionsBody.safeParse(appended).success) {
				feedback.textContent = t.instructionsLimit;
				return;
			}
			input.value = appended;
			source = { displayed: input.value, body: appended };
			feedback.textContent = "";
			input.removeAttribute("aria-invalid");
			input.focus();
		} catch {
			feedback.textContent = t.instructionFileError;
		} finally {
			importing = false;
			updateProjectField();
		}
	}
	input.oninput = () => {
		input.removeAttribute("aria-invalid");
		feedback.textContent = "";
	};
	installDropSurface(form, (context) => void addText(context));
	form.onpaste = (event) => {
		const clipboard = event.clipboardData;
		if (!clipboard) return;
		if (clipboard.files.length) {
			event.preventDefault();
			void addText(captureContext(clipboard));
		} else if (event.target === input) {
			const text = clipboard.getData("text/plain").replace(/\r\n?/g, "\n");
			const draft = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
			if (!boardInstructionsBody.safeParse(draft).success) {
				event.preventDefault();
				feedback.textContent = t.instructionsLimit;
			}
		}
	};
	if (initialContext) void addText(initialContext);
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation || importing) return;
		const board = scope;
		const checked = instructionEntryWrite.safeParse({
			entryId,
			expectedRevision: entry?.revision ?? 0,
			body: readDraft(),
			permanent: selectedAudience() === "all",
			projectId: selectedAudience() === "project" ? selectedProject : undefined,
		});
		if (!checked.success) {
			feedback.textContent = input.value.trim() ? t.instructionsLimit : t.instructionRequired;
			input.setAttribute("aria-invalid", "true");
			input.focus();
			return;
		}
		mutation = true;
		form.inert = true;
		save.disabled = true;
		try {
			await saveInstruction(checked.data);
			if (form.isConnected && scope === board) {
				if (!entry && initialContext && quickInstruction.value === initialContext.text)
					quickInstruction.value = "";
				dialog.close();
				void refreshInstructions();
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : "";
			feedback.textContent =
				reason === "conflict"
					? t.instructionsConflict
					: reason === "invalid_context"
						? t.instructionsLimit
						: t.error;
		} finally {
			form.inert = false;
			finishMutation();
			updateProjectField();
		}
	};
}

async function fetchDetails(taskId: string, edit = false): Promise<void> {
	dialogHeader(t.loading, !edit);
	const currentHeading = dialogContent.querySelector("h2");
	try {
		const task = await call<PanelDetail>("get", { taskId });
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

function showDetails(task: PanelDetail, draft?: DiscussionDraft): void {
	dialogHeader(task.reformulation?.title ?? task.title, true);
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
	const context = element("details", undefined, "detail-context");
	context.open = task.state !== "done";
	const summary = element("summary", t.currentVersion);
	const heading = dialogContent.querySelector("h2");
	function updatePresentation(shown: PanelDetail): void {
		context.hidden =
			!shown.body && !shown.attachments.length && !shown.reformulation && !shown.reformulationPending;
		if (heading) heading.textContent = shown.reformulation?.title ?? shown.title;
		const old = context.querySelector(".revision");
		const focused = [...(old?.querySelectorAll("button") ?? [])].indexOf(
			document.activeElement as HTMLButtonElement,
		);
		const originalVisible = Boolean(old?.querySelector(".revision-original[open]"));
		const revision = renderRevision(shown, shown, false);
		const original = revision.querySelector<HTMLDetailsElement>(".revision-original");
		if (original) original.open = originalVisible;
		context.replaceChildren(summary, revision);
		if (focused >= 0) revision.querySelectorAll("button")[focused]?.focus({ preventScroll: true });
	}
	updatePresentation(task);
	dialogContent.append(context);
	if (task.receipt && task.state === "done" && !task.verification && task.receipt !== task.manualValidation)
		dialogContent.append(markdownBlock(task.receipt, "markdown-content notice"));
	if (task.manualValidation) {
		const check = element("section", undefined, "detail-approval");
		check.append(element("h3", t.validatedByYou), markdownBlock(task.manualValidation));
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
			const content = element("dd", undefined, "markdown-content");
			updateMarkdown(content, value);
			proof.append(element("dt", label), content);
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
			button(t.edit, () => {
				const preserved = readDiscussionDraft?.();
				showEditor(task);
				returnToPreviousView = () => showDetails(task, preserved);
			}),
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
	readDiscussionDraft = showDiscussion(task, updatePresentation, draft);
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
	const confirm = taskSubmit(t.confirmValidation, "detail-validate");
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
		const proof = manualCheck.safeParse(observation.value);
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

function showDiscussion(
	task: PanelDetail,
	updatePresentation: (task: PanelDetail) => void,
	savedDraft?: DiscussionDraft,
): () => DiscussionDraft {
	let pendingFormat = Boolean(task.reformulationPending);
	let hasFormat = Boolean(task.reformulation);
	const section = element("section", undefined, "task-discussion");
	const list = element("ol", undefined, "comment-list");
	const form = element("form");
	const input = element("textarea");
	input.required = true;
	input.maxLength = 8192;
	input.value = savedDraft?.text ?? "";
	form.id = "task-comment-form";
	const post = taskSubmit(t.postComment, "detail-publish");
	post.setAttribute("form", form.id);
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
				message.append(group(element("strong", label), timestamp), markdownBlock(comment.body));
				item.append(avatar, message);
				return item;
			}),
		);
	}
	async function load(before?: number): Promise<void> {
		if (loading || !section.isConnected) return;
		loading = true;
		try {
			const page = await call<
				CommentsPage & {
					taskSerial: number;
					reformulationPending: boolean;
					hasReformulation: boolean;
				}
			>("comments", { taskId: task.id, before });
			const presentationChanged =
				pendingFormat !== Boolean(page.reformulationPending) || hasFormat !== Boolean(page.hasReformulation);
			if ((page.taskSerial !== task.serial || presentationChanged) && !post.disabled) {
				const updated = await call<PanelDetail>("get", { taskId: task.id });
				if (!dialog.open || !section.isConnected) return;
				if (updated.serial !== task.serial) {
					const scroll = dialogContent.scrollTop;
					showDetails(updated, {
						text: input.value,
						focused: document.activeElement === input,
						pending: draft,
					});
					dialogContent.scrollTop = scroll;
					return;
				}
				pendingFormat = Boolean(updated.reformulationPending);
				hasFormat = Boolean(updated.reformulation);
				updatePresentation(updated);
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
		const body = commentBody.safeParse(input.value);
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
			if (section.isConnected && dialog.open) {
				dialog.close();
				transferMessage(t.commentPublished);
			}
		} catch {
			feedback.textContent = t.error;
			if (section.isConnected && dialog.open) input.focus();
		} finally {
			post.disabled = false;
			input.readOnly = false;
		}
	};
	form.ondragover = (event) => event.stopPropagation();
	form.ondrop = (event) => event.stopPropagation();
	form.append(field(t.addComment, input), feedback);
	section.append(element("h3", t.comments), older, list, readError, form);
	dialogContent.append(section);
	detailFooter.replaceChildren(
		button(t.close, () => dialog.close()),
		post,
	);
	detailFooter.hidden = false;
	if (savedDraft?.focused) input.focus({ preventScroll: true });
	renderComments();
	refreshDiscussion = () => load();
	void load();
	return () => ({
		text: input.value,
		focused: document.activeElement === input,
		pending: draft,
	});
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

function renderRevision(task: PanelDetail, revision: Revision, includeTitle = true): HTMLElement {
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
	const formatted = includeTitle ? undefined : task.reformulation;
	if (!includeTitle && task.reformulationPending) section.append(element("p", t.titlePending, "meta"));
	if (revision.body || formatted) section.append(markdownBlock(formatted?.body ?? revision.body));
	if (formatted) {
		const original = element("details", undefined, "revision-original");
		const raw = revision.body ? `${revision.title}\n\n${revision.body}` : revision.title;
		original.append(element("summary", t.originalText), element("pre", raw));
		section.append(original);
	}
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
	if (task) title.maxLength = 240;
	title.value = focusContext ? "" : (task?.title ?? "");
	const body = element("textarea");
	body.name = "body";
	body.maxLength = MAX_TASK_BODY_BYTES;
	body.value = task?.body ?? "";
	const initialBody = body.value;
	const updateTitleHint = () => {
		title.placeholder = body.value.trim() ? contextTitle({ files: [], text: body.value }, "") : "";
	};
	body.oninput = updateTitleHint;
	updateTitleHint();
	const mode = element("select");
	mode.name = "mode";
	mode.add(new Option(t.auto, "auto"));
	mode.add(new Option(t.thread, "thread"));
	mode.value = task?.mode ?? "auto";
	const taskId = task?.id ?? newTaskId();
	const save = taskSubmit(t.save, "primary");
	const status = element("p", undefined, "notice");
	status.setAttribute("role", "status");
	const attachments = makeAttachments(task, status);
	form.append(
		field(t.optionalTitle, title),
		field(t.detail, body),
		field(t.delegation, mode),
		attachments.section,
		status,
		group(save),
	);
	const addContext = (context: TransferredContext) => {
		if (context.files.length) attachments.addFiles(context.files);
		if (context.text) {
			body.value = appendContextText(body.value, context.text);
			updateTitleHint();
		}
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
	const savingStatus = element("p", undefined, "notice");
	savingStatus.setAttribute("role", "status");
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation) return;
		const board = scope;
		const details = body.value === initialBody ? (task?.body ?? body.value) : body.value;
		const providedTitle = title.value.trim();
		const files = attachments.selectedFiles();
		const kept = attachments.keep();
		const retainedName = task?.attachments.find((file) => kept.includes(file.id))?.name;
		if (!providedTitle && !retainedName && !hasContext({ files, text: details })) {
			status.textContent = t.addTaskContext;
			body.focus();
			return;
		}
		const titleOnly = !task && providedTitle && !details.trim() && !files.length;
		if (
			titleOnly &&
			(title.value.length > MAX_TASK_BODY_BYTES || byteLength(title.value) > MAX_TASK_BODY_BYTES)
		) {
			status.textContent = t.taskTextTooLong;
			title.focus();
			return;
		}
		if (!titleOnly && providedTitle && !taskInput.shape.title.safeParse(providedTitle).success) {
			status.textContent = t.taskTitleTooLong;
			title.focus();
			return;
		}
		const content = titleOnly
			? titleOnlyInput(title.value)
			: {
					title:
						providedTitle ||
						contextTitle(
							{ files: details.trim() ? [] : files, text: details.trim() ? details : (retainedName ?? "") },
							t.newTask,
						),
					body: details,
				};
		mutation = true;
		save.disabled = true;
		form.inert = true;
		savingStatus.textContent = t.saving;
		status.textContent = "";
		try {
			const input = {
				...content,
				mode: mode.value,
				keep: attachments.keep(),
				files: await attachments.encode(),
			};
			if (scope !== board || !form.isConnected) return;
			if (task) {
				const previouslyEmpty = !task.body.trim();
				await call("edit", {
					taskId,
					input,
					expectedRevision: task.revision,
					preserveTitle: providedTitle === task.title,
					preserveBody: details === task.body || (previouslyEmpty && !details.trim()),
					appendBody: previouslyEmpty && details.trim() ? details : "",
					...(providedTitle !== task.title || details !== task.body ? { reformulate: locale } : {}),
				});
			}
			const added = task ? undefined : await createTask({ taskId, input, reformulate: locale }, true);
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
		selectedFiles: () => selected,
		keep: () => existing.map((file) => file.id),
		encode: () => encodeFiles(selected, existing.length),
	};
}

/** Installs a drop target whose hint follows drag enter/leave without tracking the pointer. */
function installDropSurface(
	target: HTMLElement,
	receive: (context: TransferredContext, event: DragEvent) => void,
	enabled = () => true,
): void {
	const clear = () => target.classList.remove("drop-armed");
	target.ondragover = (event) => {
		if (!scope || !enabled() || !acceptsContext(event.dataTransfer)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		target.classList.add("drop-armed");
	};
	target.ondragleave = (event) => {
		if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) clear();
	};
	target.ondrop = (event) => {
		clear();
		if (!scope || !enabled() || !event.dataTransfer || !acceptsContext(event.dataTransfer)) return;
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
					...(task
						? {
								expectedRevision: task.revision,
								preserveTitle: true,
								preserveBody: !context.text,
								appendBody: context.text,
								...(context.text ? { reformulate: locale } : {}),
							}
						: { ...(context.text ? { reformulate: locale } : {}) }),
					input: {
						title: task?.title ?? contextTitle(context, t.newTask),
						body: task?.body ?? context.text,
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
				code === "conflict"
					? t.unsigned
					: code === "invalid_attachment"
						? t.fileError
						: code === "invalid_context"
							? t.taskTextTooLong
							: t.contextError;
			const retry = ["conflict", "invalid_attachment", "invalid_context"].includes(code)
				? undefined
				: () => void save();
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

installDropSurface(
	main,
	(context) => void saveDroppedContext(context),
	() => Boolean(instructionPanel.hidden),
);
installDropSurface(
	instructionPanel,
	(context) => {
		if (!mutation && !dialog.open) showInstructionEditor(undefined, context);
	},
	() => !instructionPanel.hidden,
);
document.addEventListener("paste", (event) => {
	if (
		!scope ||
		!instructionPanel.hidden ||
		dialog.open ||
		!event.clipboardData ||
		!acceptsContext(event.clipboardData)
	)
		return;
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
	instructionAdd.disabled = false;
	instructionSignature = "";
	deferredInstruction = undefined;
	instructionProjects = [];
	instructionTab.textContent = t.instructions;
	quickInstruction.value = "";
	unsavedInstruction = undefined;
	instructionList.replaceChildren();
	if (!instructionPanel.hidden) void refreshInstructionProjects().then(refreshInstructions);
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
	else if (instructionPanel.hidden) void refresh();
	else void refreshInstructions();
}, POLL_MS);
window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
