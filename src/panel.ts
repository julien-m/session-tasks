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
	type BoardPanelView,
	boardInstructionsBody,
	boardPanelView,
	byteLength,
	commentContent,
	type InstructionBinding,
	type InstructionEntryWrite,
	type InstructionProject,
	type InstructionTarget,
	id,
	instructionEntryWrite,
	MAX_BOARD_INSTRUCTIONS_BYTES,
	MAX_COMMENT_BYTES,
	MAX_INSTRUCTION_TARGETS,
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
import { keepsMarkdownLinks, renderLinkableText, renderMarkdown } from "./markdown-view.ts";
import { catalog } from "./messages.ts";
import {
	type QuickAction,
	quickActionCodePrefix,
	quickActionColors,
	quickActionInput,
	quickActionTitlePrefix,
} from "./quick-actions-contract.ts";
import type { BoardList, CommentsPage } from "./repository.ts";

const locale = /^fr(?:-|$)/i.test(navigator.language) ? "fr" : "en";
const t = catalog(locale);
const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
const relativeDate = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
const safeImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const app = new App({ name: "Session Tasks", version: manifest.version }, {});
const POLL_MS = 1800;
const SUCCESS_NOTICE_MS = 5000;

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

function showSuccessNotice(container: HTMLElement, text: string): void {
	const message = element("span", text);
	container.replaceChildren(message);
	window.setTimeout(() => message.remove(), SUCCESS_NOTICE_MS);
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

function openMarkdownLink(content: HTMLElement, url: string): boolean {
	if (!app.getHostCapabilities()?.openLinks) return false;
	content.querySelector("[data-link-error]")?.remove();
	const reportError = () => {
		const notice = element("p", t.linkOpenError, "meta");
		notice.dataset.linkError = "";
		notice.setAttribute("role", "status");
		content.querySelector("[data-link-error]")?.replaceWith(notice);
		if (!notice.isConnected) content.append(notice);
	};
	void app.openLink({ url }).then(({ isError }) => {
		if (isError) reportError();
	}, reportError);
	return true;
}

function updateMarkdown(content: HTMLElement, source: string): void {
	renderMarkdown(content, source, (url) => openMarkdownLink(content, url));
}

function originalBlock(source: string): HTMLElement {
	const content = element("div", undefined, "markdown-content");
	const original = element("pre");
	renderLinkableText(original, source, (url) => openMarkdownLink(content, url));
	content.append(original);
	return content;
}

function markdownBlock(source: string, className = "markdown-content"): HTMLDivElement {
	const content = element("div", undefined, className);
	updateMarkdown(content, source);
	return content;
}

let scope: string | undefined;
async function call<T>(name: string, args: Record<string, unknown> = {}, timeout = 10000): Promise<T> {
	if (!scope) throw new Error("invalid_scope");
	const response = await app.callServerTool(
		{ name: `task_panel_${name}`, arguments: { scope, ...args } },
		{ timeout, maxTotalTimeout: timeout },
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
		void resumeChat("task");
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
const mouseBackButton = 3;
let handledMouseBack = false;
window.addEventListener(
	"pointerdown",
	(event) => {
		handledMouseBack = event.button === mouseBackButton && dialog.open;
		if (!handledMouseBack) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		goBackInPanel();
	},
	{ capture: true },
);
// Consume the rest of the gesture even when Back has already closed the dialog.
for (const phase of ["mousedown", "pointerup", "mouseup", "auxclick"] as const) {
	window.addEventListener(
		phase,
		(event) => {
			if (event.button !== mouseBackButton) return;
			const auxiliaryBack = phase === "auxclick" && dialog.open;
			if (!handledMouseBack && !auxiliaryBack) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (phase === "auxclick") {
				if (!handledMouseBack) goBackInPanel();
				handledMouseBack = false;
			}
		},
		{ capture: true },
	);
}
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
const more = button(
	"›",
	() => {
		if (next === null) return;
		pageHistory.push(cursor);
		cursor = next;
		void resetPage();
		rememberPanelView();
	},
	"icon-button",
);
const previous = button(
	"‹",
	() => {
		cursor = pageHistory.pop() ?? previousAfter ?? 0;
		void resetPage();
		rememberPanelView();
	},
	"icon-button",
);
for (const [control, label] of [
	[previous, t.previous],
	[more, t.more],
] as const) {
	control.title = label;
	control.setAttribute("aria-label", label);
	control.hidden = true;
}
const resume = button(t.resume, () => void resumeChat(), "resume-action");
resume.dataset.testid = "resume-tasks";
const resumeIcon = element("span", "▷");
resumeIcon.setAttribute("aria-hidden", "true");
resume.prepend(resumeIcon);
resume.hidden = true;
const jumpToLatest = button("↓", () => void refresh(true, true), "icon-button");
jumpToLatest.title = t.latestTasks;
jumpToLatest.setAttribute("aria-label", t.latestTasks);
jumpToLatest.disabled = true;
const listNavigation = group(previous, more, jumpToLatest);
listNavigation.classList.add("list-navigation");
const reorderHint = element("p", undefined, "notice");
reorderHint.setAttribute("role", "status");
const dragPositionNotice = element("p", undefined, "visually-hidden");
dragPositionNotice.setAttribute("role", "status");
const reorder = button(
	t.reorderBoard,
	() => {
		void switchList(["remaining"]).then(() => {
			const first = rows.querySelector<HTMLButtonElement>(".reorder-handle:not(:disabled)");
			if (first) first.focus();
			else reorderHint.textContent = t.reorderUnavailable;
		});
	},
	"quiet reorder-board",
);
const waitingTitle = element("h2", t.waitingTasks);
const reorderBar = group(waitingTitle, reorder);
reorderBar.classList.add("reorder-bar");
const filterBar = group(filters, cancelledFilter, resume, listNavigation);
filterBar.classList.add("board-filters");
const boardHeader = element("header", undefined, "board-header");
const taskTab = button(t.heading, () => selectBoardTab(0));
const instructionTab = button(t.instructions, () => selectBoardTab(1));
const actionsTab = button(t.quickActions, () => selectBoardTab(2));
const tabs = [taskTab, instructionTab, actionsTab];
const tabList = group(...tabs);
tabList.classList.add("board-tabs");
tabList.setAttribute("role", "tablist");
tabList.setAttribute("aria-label", t.boardViews);
for (const [index, tab] of tabs.entries()) {
	tab.id = ["tab-tasks", "tab-instructions", "tab-actions"][index] ?? "";
	tab.setAttribute("role", "tab");
	tab.setAttribute("aria-selected", String(index === 0));
	tab.tabIndex = index === 0 ? 0 : -1;
	tab.onkeydown = (event) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? tabs.length - 1
					: (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
		selectBoardTab(next);
		tabs[next]?.focus();
	};
}
boardHeader.append(tabList);
const boardList = element("div", undefined, "board-list");
boardList.append(transferNotice, notice, reorderBar, reorderHint, dragPositionNotice, rows, dropZone);
const addRow = element("div", undefined, "board-add");
addRow.append(quickAdd, add);
const boardFooter = element("footer", undefined, "board-footer");
boardFooter.append(filterBar, element("small", `v${manifest.version}`, "meta"), progressGroup, addRow);
const taskPanel = element("section", undefined, "board-tab-panel");
const instructionPanel = element("section", undefined, "board-tab-panel");
const actionsPanel = element("section", undefined, "board-tab-panel");
const boardPanels = [
	[taskPanel, taskTab],
	[instructionPanel, instructionTab],
	[actionsPanel, actionsTab],
] as const;
for (const [panel, tab] of boardPanels) {
	panel.setAttribute("role", "tabpanel");
	panel.setAttribute("aria-labelledby", tab.id);
}
const instructionList = element("ul", undefined, "rows");
const instructionNotice = element("p", t.loading, "notice");
instructionNotice.setAttribute("role", "status");
const instructionScroll = element("div", undefined, "board-list");
const instructionFeedback = element("div", undefined, "group instruction-feedback");
instructionFeedback.setAttribute("role", "status");
const showCurrentInstructions = button(t.instructionActive, () => selectInstructionHistory(false));
const showInstructionHistory = button(t.instructionHistory, () => selectInstructionHistory(true));
const instructionViews = group(showCurrentInstructions, showInstructionHistory);
instructionViews.classList.add("instruction-views");
showCurrentInstructions.setAttribute("aria-pressed", "true");
showInstructionHistory.setAttribute("aria-pressed", "false");
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
instructionFooter.append(
	instructionFeedback,
	element("small", `v${manifest.version}`, "meta"),
	instructionAddRow,
);
taskPanel.append(boardList, boardFooter);
instructionPanel.append(instructionViews, instructionScroll, instructionFooter);
instructionPanel.hidden = true;
actionsPanel.hidden = true;
const actionShelf = element("aside", undefined, "action-shelf");
actionShelf.setAttribute("aria-label", t.runActions);
actionShelf.hidden = true;
const actionButtons = element("div", undefined, "action-buttons");
const actionFeedback = element("p", undefined, "meta action-feedback");
actionFeedback.setAttribute("role", "status");
actionShelf.append(element("h2", t.runActions), actionButtons, actionFeedback);
const actionList = element("div", undefined, "board-list action-library");
const actionLibraryFeedback = element("p", undefined, "notice");
actionLibraryFeedback.setAttribute("role", "status");
const actionAdd = button(t.addQuickAction, () => showActionEditor());
actionAdd.disabled = true;
const actionAddRow = group(actionAdd);
actionsPanel.append(actionList, actionLibraryFeedback, actionAddRow);
const boardSurface = element("div", undefined, "board-surface");
boardSurface.append(taskPanel, instructionPanel, actionsPanel);
const actionShelfAnchors = [addRow, instructionAddRow, actionAddRow];
function placeActionShelf(): void {
	const selected = boardPanels.findIndex(([panel]) => !panel.hidden);
	const anchor = actionShelfAnchors[selected];
	if (!anchor || actionShelf.nextElementSibling === anchor) return;
	const focused = document.activeElement;
	anchor.before(actionShelf);
	if (focused instanceof HTMLElement && actionShelf.contains(focused)) focused.focus();
}
placeActionShelf();
main.append(boardHeader, boardSurface);
document.documentElement.lang = locale;
document.body.append(main, dialog);

let selectedFilters: BoardPanelView["filters"] = [];
let refreshDiscussion: (() => Promise<void>) | undefined;
let next: number | null = null;
let cursor = 0;
let previousAfter: number | null = null;
let lastAgentOrdinal: number | undefined;
const pageHistory: number[] = [];
const panelScrollViews = [boardList, instructionScroll, actionList];
let viewReady = false;
let viewWritable = false;
let viewBindingGeneration = 0;
let viewSignature = "";
let viewWrites = Promise.resolve();
let savedScroll: { tab: number; top: number } | undefined;
let viewScrollTimer: number | undefined;

function rememberPanelView(): void {
	const board = scope;
	if (!board || !viewReady || !viewWritable) return;
	const tab = boardPanels.findIndex(([panel]) => !panel.hidden);
	const scrollTop = savedScroll?.tab === tab ? savedScroll.top : (panelScrollViews[tab]?.scrollTop ?? 0);
	const view: BoardPanelView = {
		tab,
		filters: selectedFilters,
		instructionHistory,
		cursor,
		scrollTop: Math.max(0, Math.round(scrollTop)),
	};
	const signature = JSON.stringify(view);
	if (signature === viewSignature) return;
	viewSignature = signature;
	viewWrites = viewWrites.then(async () => {
		try {
			await call("save_view", { scope: board, view }, 3000);
		} catch {
			if (scope === board && viewSignature === signature) viewSignature = "";
		}
	});
}

function flushPanelViewScroll(): void {
	window.clearTimeout(viewScrollTimer);
	viewScrollTimer = undefined;
	rememberPanelView();
}

function restorePanelScroll(tab: number): void {
	if (savedScroll?.tab !== tab || boardPanels[tab]?.[0].hidden) return;
	const scrollView = panelScrollViews[tab];
	if (scrollView) scrollView.scrollTop = savedScroll.top;
	savedScroll = undefined;
}

for (const [tab, scrollView] of panelScrollViews.entries()) {
	scrollView.addEventListener(
		"scroll",
		() => {
			if (boardPanels[tab]?.[0].hidden || !viewReady) return;
			window.clearTimeout(viewScrollTimer);
			viewScrollTimer = window.setTimeout(flushPanelViewScroll, 120);
		},
		{ passive: true },
	);
}
type PanelTask = BoardList["tasks"][number] & { titlePending?: boolean };
type PanelDetail = Task & { reformulation?: Reformulation; reformulationPending?: boolean };
type PanelBoardList = Omit<BoardList, "tasks"> & {
	tasks: PanelTask[];
	pendingComments?: boolean;
	pendingEdits?: boolean;
};
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
const updateLatestButton = () => {
	const atBottom = boardList.scrollHeight - boardList.clientHeight - boardList.scrollTop <= 1;
	jumpToLatest.disabled = next === null && atBottom;
};
boardList.addEventListener("scroll", updateLatestButton, { passive: true });
new ResizeObserver(updateLatestButton).observe(boardList);

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

function taskReorderHandle(task: PanelTask, row: HTMLLIElement, controls: HTMLDivElement): HTMLButtonElement {
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
	let previewRow: HTMLElement | undefined;
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
		if (!previewRow) {
			previewRow = element("div", task.title, "reorder-preview");
			previewRow.setAttribute("aria-hidden", "true");
			boardList.append(previewRow);
		}
		previewRow.style.insetInlineStart = `${Math.max(8, Math.min(event.clientX + 10, innerWidth - previewRow.offsetWidth - 8))}px`;
		previewRow.style.insetBlockStart = `${Math.max(8, event.clientY - previewRow.offsetHeight - 8)}px`;
		const candidate = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>(".task[data-state=queued]");
		const next = candidate && candidate !== row && rows.contains(candidate) ? candidate : undefined;
		if (next === targetRow) return;
		targetRow?.classList.remove("reorder-target");
		targetRow = next;
		const queued = current.filter((entry) => entry.state === "queued");
		const index = queued.findIndex((entry) => entry.id === targetRow?.dataset.taskId);
		if (targetRow && index >= 0) {
			const label = t.reorderPosition(index + 1);
			targetRow.dataset.dropPosition = label;
			targetRow.dataset.dropSide =
				queued.findIndex((entry) => entry.id === task.id) > index ? "before" : "after";
			targetRow.classList.add("reorder-target");
			dragPositionNotice.textContent = label;
		} else dragPositionNotice.textContent = "";
	};
	function endDrag(event: PointerEvent, commit: boolean): void {
		if (!start || start.id !== event.pointerId) return;
		const destination = targetRow?.dataset.taskId;
		const active = draggedTask?.id === task.id;
		start = undefined;
		draggedTask = undefined;
		skipClick = active;
		row.classList.remove("reorder-source");
		previewRow?.remove();
		previewRow = undefined;
		dragPositionNotice.textContent = "";
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
		controls.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
	};
	const move = (offset: number) => {
		grip.focus();
		selectNeighbor(offset);
	};
	const up = button("↑", () => move(-1), "icon-button move-up");
	const down = button("↓", () => move(1), "icon-button move-down");
	up.title = t.moveUp;
	up.setAttribute("aria-label", t.moveUp);
	down.title = t.moveDown;
	down.setAttribute("aria-label", t.moveDown);
	up.disabled = !neighbor(-1);
	down.disabled = !neighbor(1);
	controls.append(up, down);
	controls.hidden = up.disabled && down.disabled;
	controls.setAttribute("role", "group");
	controls.setAttribute("aria-label", `${t.reorderTask} · ${task.title}`);
	grip.setAttribute("aria-controls", controls.id);
	return grip;
}

function applyFilters(values: BoardPanelView["filters"]): void {
	selectedFilters = values;
	for (const { value, toggle } of filterButtons)
		toggle.setAttribute("aria-pressed", String(values.includes(value)));
	cancelledFilter.setAttribute("aria-pressed", String(values.includes("cancelled")));
}

function switchList(values: BoardPanelView["filters"]): Promise<void> {
	reorderHint.textContent = "";
	if (savedScroll?.tab === 0) savedScroll = undefined;
	applyFilters(values);
	cursor = 0;
	previousAfter = null;
	pageHistory.length = 0;
	const loading = resetPage();
	rememberPanelView();
	return loading;
}

function resetPage(tail = false): Promise<void> {
	boardList.scrollTop = 0;
	current = [];
	next = null;
	lastRender = "";
	rows.replaceChildren();
	more.disabled = true;
	previous.disabled = true;
	notice.textContent = t.loading;
	return refresh(true, tail);
}

async function resumeChat(source: "manual" | "task" | "comment" = "manual"): Promise<void> {
	if (resume.disabled) return;
	resume.disabled = true;
	try {
		const board = scope;
		const request = await call<{ requested: boolean; code?: string }>("request_resume");
		if (!request.requested || !request.code || scope !== board) return;
		const prompts = { manual: t.resumePrompt, task: t.automaticResumePrompt, comment: t.commentResumePrompt };
		const response = await app.sendMessage(
			{
				role: "user",
				content: [{ type: "text", text: `${prompts[source]}\n\n${resumeCodePrefix}${request.code}` }],
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

async function refresh(force = false, tail = false): Promise<void> {
	if (!scope || (refreshing && !force)) return;
	refreshing = true;
	const generation = ++refreshGeneration;
	const visible = () => !taskPanel.hidden && !dialog.open && !draggedTask;
	try {
		const request = (lastPage: boolean) =>
			call<PanelBoardList>("list", { after: cursor, filters: selectedFilters, tail: lastPage });
		const atTail = tail && visible();
		let page = await request(atTail);
		if (generation !== refreshGeneration || (atTail && !visible())) return;
		const newest = page.viewport?.latestAgentOrdinal;
		const needsJump =
			!atTail &&
			visible() &&
			newest !== undefined &&
			lastAgentOrdinal !== undefined &&
			newest > lastAgentOrdinal;
		if (needsJump) {
			page = await request(true);
			if (generation !== refreshGeneration || !visible()) return;
		}
		if (newest !== undefined) lastAgentOrdinal = Math.max(lastAgentOrdinal ?? 0, newest);
		if ((atTail || needsJump) && page.viewport) pageHistory.length = 0;
		cursor = page.viewport?.after ?? cursor;
		previousAfter = page.viewport?.previousAfter ?? null;
		current = page.tasks;
		next = page.next;
		render(page.counts, Boolean(page.pendingComments || page.pendingEdits));
		if ((atTail || needsJump) && visible()) {
			savedScroll = undefined;
			boardList.scrollTop = boardList.scrollHeight;
			rememberPanelView();
		} else restorePanelScroll(0);
	} catch {
		if (generation === refreshGeneration) notice.textContent = t.error;
	} finally {
		if (generation === refreshGeneration) refreshing = false;
	}
}

async function revealCreatedTask(task: Task): Promise<void> {
	const loading = refresh(true);
	const generation = refreshGeneration;
	await loading;
	if (generation !== refreshGeneration || dialog.open) return;
	if (selectedFilters.length && !selectedFilters.includes("remaining")) return;
	const last = current.at(-1);
	if (next !== null && last && last.position < task.ordinal) {
		pageHistory.push(cursor);
		cursor = task.ordinal - 1;
		await resetPage();
	}
	rows.querySelector(`[data-task-id="${task.id}"]`)?.scrollIntoView({ block: "nearest" });
}

function render(counts: BoardList["counts"], pendingUpdates: boolean): void {
	const total = counts.queued + counts.running + counts.blocked + counts.done;
	progressGroup.hidden = total === 0;
	progress.max = Math.max(1, total);
	progress.value = counts.done;
	progressText.textContent = total ? `${counts.done}/${total}` : "";
	taskTab.textContent = total ? `${t.heading} ${total}` : t.heading;
	progressText.setAttribute("aria-label", t.completed({ done: counts.done, total }));
	const hasPreviousPage = pageHistory.length > 0 || previousAfter !== null;
	const hasNextPage = next !== null;
	previous.hidden = more.hidden = !hasPreviousPage && !hasNextPage;
	more.disabled = !hasNextPage;
	previous.disabled = !hasPreviousPage;
	waitingTitle.textContent = `${t.waitingTasks} · ${counts.queued}`;
	reorder.disabled = counts.queued < 2;
	reorderHint.textContent = reorder.disabled && current.length ? t.reorderUnavailable : "";
	resume.hidden = (counts.queued === 0 && !pendingUpdates) || !app.getHostCapabilities()?.message?.text;
	cancelledFilter.hidden = counts.cancelled === 0;
	notice.textContent = current.length
		? ""
		: selectedFilters.length === 0
			? t.empty
			: selectedFilters.length === 1 && selectedFilters[0] === "cancelled"
				? t.emptyCancelled
				: t.emptyFilter;
	const signature = JSON.stringify([
		Math.floor(Date.now() / 60000),
		current.map(({ id, serial, title, titlePending }) => [id, serial, title, titlePending]),
	]);
	if (signature === lastRender || draggedTask) {
		updateLatestButton();
		return;
	}
	lastRender = signature;
	const active = document.activeElement;
	const focusedTask = rows.contains(active) ? dropTaskId(active) : undefined;
	const focusClass =
		["reorder-handle", "move-up", "move-down", "row-edit", "task-marker", "task-title"].find((name) =>
			active?.classList.contains(name),
		) ?? "task-title";
	rows.replaceChildren(...current.map(renderTask));
	updateLatestButton();
	if (focusedTask)
		rows
			.querySelector<HTMLButtonElement>(`[data-task-id="${CSS.escape(focusedTask)}"] .${focusClass}`)
			?.focus({ preventScroll: true });
}

function renderTaskDates(
	task: { firstCreatedAt?: number; completedAt?: number; completedAtEstimated?: boolean },
	absolute = false,
): HTMLDivElement {
	const dates = group();
	dates.classList.add("task-dates");
	for (const [label, date] of [
		[t.taskCreatedAt, task.firstCreatedAt],
		[
			task.completedAtEstimated ? `${t.taskCompletedAt} (${t.taskCompletionEstimated})` : t.taskCompletedAt,
			task.completedAt,
		],
	] as const) {
		if (date === undefined) continue;
		const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000));
		const [unit, elapsed] =
			seconds >= 86400
				? (["day", Math.floor(seconds / 86400)] as const)
				: seconds >= 3600
					? (["hour", Math.floor(seconds / 3600)] as const)
					: (["minute", Math.floor(seconds / 60)] as const);
		const exact = dateFormat.format(date);
		const time = element(
			"time",
			`${label} ${absolute ? exact : seconds < 60 ? t.justNow : relativeDate.format(-elapsed, unit)}`,
			"meta",
		);
		time.dateTime = new Date(date).toISOString();
		time.title = exact;
		time.setAttribute("aria-label", `${label} ${exact}`);
		dates.append(time);
	}
	if (absolute && task.firstCreatedAt !== undefined && task.completedAt !== undefined) {
		const minutes = Math.max(0, Math.floor((task.completedAt - task.firstCreatedAt) / 60000));
		const parts: string[] = [];
		if (minutes >= 60)
			parts.push(
				new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "short" }).format(
					Math.floor(minutes / 60),
				),
			);
		parts.push(
			new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(
				minutes % 60,
			),
		);
		dates.append(element("span", `${t.taskDuration} · ${parts.join(" ")}`, "meta"));
	}
	return dates;
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
	const edit = button("✎", () => void fetchDetails(task.id, "edit"), "icon-button row-edit");
	edit.setAttribute("aria-label", `${t.edit} · ${task.title}`);
	const line = group(title);
	const controls = element("div", undefined, "group reorder-controls");
	controls.id = `reorder-controls-${task.id}`;
	line.classList.add("row-title");
	if (task.state !== "cancelled") line.append(edit);
	if (task.state === "queued") {
		const grip = taskReorderHandle(task, row, controls);
		grip.disabled = current.filter((entry) => entry.state === "queued").length < 2;
		if (grip.disabled) grip.title = t.reorderUnavailable;
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
	const dates = renderTaskDates(task);
	if (task.state === "queued") {
		const dateControls = group(dates, controls);
		dateControls.classList.add("task-date-controls");
		summary.append(dateControls);
	} else if (dates.childElementCount) summary.append(dates);
	if (task.blockedReason) {
		const blocked = element("div", undefined, "blocker");
		const reason =
			Array.from(task.blockedReason).length > 160
				? `${task.blockedReason.replace(/\S+$/u, "").trimEnd()}…`
				: task.blockedReason;
		blocked.append(
			markdownBlock(reason),
			button(t.resolveBlocker, () => void fetchDetails(task.id, "unblock")),
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

let instructionHistory = false;
let currentInstructionProject: string | undefined;

function applyInstructionHistory(history: boolean): void {
	instructionHistory = history;
	showCurrentInstructions.setAttribute("aria-pressed", String(!history));
	showInstructionHistory.setAttribute("aria-pressed", String(history));
}

function selectInstructionHistory(history: boolean): void {
	if (instructionHistory === history) return;
	if (savedScroll?.tab === 1) savedScroll = undefined;
	applyInstructionHistory(history);
	instructionScroll.scrollTop = 0;
	rememberPanelView();
	void refreshInstructions();
}

function instructionBindingName(binding: InstructionBinding): string {
	if (binding.kind === "project")
		return (
			instructionProjects.find((project) => project.id === binding.projectId)?.name ?? t.instructionProject
		);
	if (binding.kind === "other_chat") return t.otherInstructionChat;
	return binding.kind === "global" ? t.instructionsAllChats : t.instructionsThisChat;
}

function instructionBadges(entry: PresentedInstruction): HTMLDivElement {
	const badges = group();
	badges.classList.add("instruction-badges");
	for (const binding of entry.bindings ?? [])
		badges.append(element("span", instructionBindingName(binding), "meta"));
	if (!badges.hasChildNodes()) badges.append(element("span", t.instructionUnassigned, "meta"));
	return badges;
}

function appliesHere(binding: InstructionBinding): boolean {
	return (
		binding.kind === "global" ||
		binding.kind === "chat" ||
		(binding.kind === "project" && binding.projectId === currentInstructionProject)
	);
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

function selectBoardTab(selected: number, restoring = false): void {
	const changed = boardPanels[selected]?.[0].hidden;
	for (const [index, [panel, tab]] of boardPanels.entries()) {
		const active = index === selected;
		panel.hidden = !active;
		tab.tabIndex = active ? 0 : -1;
		tab.setAttribute("aria-selected", String(active));
	}
	if (!changed) return;
	placeActionShelf();
	if (restoring) return;
	rememberPanelView();
	if (selected === 0) void refresh(true);
	if (selected === 1) void refreshInstructionProjects().then(refreshInstructions);
	if (selected === 2) void refreshActions();
}

type ActionSummary = Omit<QuickAction, "body"> & { optimizing?: boolean };
let actionSignature = "";
let actionLoading = false;
let actionProjects: InstructionProject[] = [];
let actionDispatching = false;
const recentActions = new Map<string, number>();

function colorAction(button: HTMLElement, color: string | null): void {
	if (color) button.style.setProperty("--action-color", color);
}

async function refreshActions(): Promise<void> {
	if (!scope || actionLoading) return;
	const board = scope;
	actionLoading = true;
	try {
		const { actions, projects } = await call<{ actions: ActionSummary[]; projects: InstructionProject[] }>(
			"actions",
		);
		if (scope !== board) return;
		const signature = JSON.stringify(actions);
		actionProjects = projects;
		if (signature === actionSignature) {
			restorePanelScroll(2);
			return;
		}
		actionSignature = signature;
		const available = actions.filter((action) => action.available);
		actionShelf.hidden = available.length === 0;
		const focused =
			document.activeElement instanceof HTMLElement ? document.activeElement.dataset.actionFocus : undefined;
		actionButtons.replaceChildren(
			...available.map((action) => {
				const control = button("", () => void sendAction(action), "quick-action");
				control.title = action.optimizing ? `${action.title} · ${t.actionOptimizing}` : action.title;
				control.disabled = Boolean(action.optimizing);
				control.dataset.actionFocus = `run-${action.id}`;
				control.append(element("span", action.title, "quick-action-title"));
				colorAction(control, action.color);
				return control;
			}),
		);
		actionList.replaceChildren(
			...actions.map((action, index) => {
				const row = element("div", undefined, "group action-library-row");
				const edit = button(action.title, () => void loadActionEditor(action.id));
				edit.title = action.title;
				edit.disabled = Boolean(action.optimizing);
				edit.dataset.actionFocus = `edit-${action.id}`;
				colorAction(edit, action.color);
				const moveControls = [-1, 1].map((offset) => {
					const target = actions[index + offset];
					const move = button(
						offset < 0 ? "↑" : "↓",
						() => {
							if (target)
								void mutateAction("move_action", {
									actionId: action.id,
									targetId: target.id,
									position: action.position,
									targetPosition: target.position,
								});
						},
						"icon-button",
					);
					move.disabled = !target;
					move.setAttribute("aria-label", `${offset < 0 ? t.moveUp : t.moveDown} · ${action.title}`);
					return move;
				});
				const audience =
					action.audience.kind === "chat"
						? t.instructionsThisChat
						: action.audience.kind === "global"
							? t.instructionsAllChats
							: action.audience.ids
									.map(
										(id) => actionProjects.find((project) => project.id === id)?.name ?? t.instructionProject,
									)
									.join(", ");
				const details = element("div", undefined, "stack action-library-copy");
				details.append(
					edit,
					element("small", action.available ? audience : `${audience} · ${t.actionOutsideScope}`, "meta"),
				);
				if (action.optimizing) details.append(element("small", t.actionOptimizing, "meta"));
				row.append(details, group(...moveControls));
				return row;
			}),
		);
		if (!actions.length) actionList.append(element("p", t.noQuickActions, "notice"));
		restorePanelScroll(2);
		if (focused)
			boardSurface
				.querySelector<HTMLElement>(`[data-action-focus="${CSS.escape(focused)}"]`)
				?.focus({ preventScroll: true });
	} catch {
		if (scope === board && !actionsPanel.hidden) actionLibraryFeedback.textContent = t.error;
	} finally {
		actionLoading = false;
	}
}

async function sendAction(action: ActionSummary): Promise<void> {
	const board = scope;
	const now = performance.now();
	if (!board || actionDispatching || now - (recentActions.get(action.id) ?? -1000) < 800) return;
	if (!app.getHostCapabilities()?.message?.text) {
		actionFeedback.textContent = t.actionCannotSend;
		return;
	}
	recentActions.set(action.id, now);
	actionDispatching = true;
	actionFeedback.textContent = "";
	try {
		const request = await call<{ code?: string }>("request_action", {
			actionId: action.id,
			revision: action.revision,
		});
		if (scope !== board) return;
		if (!request.code) throw new Error("action_pending");
		const sent = await app.sendMessage(
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `${quickActionTitlePrefix}${action.title}\n\n${quickActionCodePrefix}${request.code}`,
					},
				],
			},
			{ timeout: 10000, maxTotalTimeout: 10000 },
		);
		if (sent.isError) throw new Error("host_rejected");
		if (scope === board) showSuccessNotice(actionFeedback, t.actionSent);
	} catch {
		if (scope === board) actionFeedback.textContent = t.actionCannotSend;
	} finally {
		actionDispatching = false;
	}
}

async function mutateAction(
	operation: "move_action" | "remove_action",
	args: Record<string, unknown>,
): Promise<boolean> {
	if (mutation) return false;
	const board = scope;
	mutation = true;
	actionLibraryFeedback.textContent = "";
	try {
		await call(operation, args);
		if (scope === board) void refreshActions();
		return scope === board;
	} catch {
		actionLibraryFeedback.textContent = t.error;
		return false;
	} finally {
		finishMutation();
	}
}

async function loadActionEditor(actionId: string): Promise<void> {
	const board = scope;
	try {
		const action = await call<QuickAction>("get_action", { actionId });
		if (scope === board && !actionsPanel.hidden && !dialog.open) showActionEditor(action);
	} catch {
		if (scope === board) actionLibraryFeedback.textContent = t.error;
	}
}

function showActionEditor(action?: QuickAction): void {
	dialogHeader(action?.title ?? t.addQuickAction);
	const form = element("form");
	const title = element("input");
	title.value = action?.title ?? "";
	title.maxLength = 48;
	title.placeholder = t.actionTitleAutomatic;
	const body = element("textarea", undefined, "quick-action-text");
	body.value = action?.body ?? "";
	const sourceText = action ? { displayed: body.value, saved: action.body } : undefined;
	const currentBody = () => (sourceText?.displayed === body.value ? sourceText.saved : body.value);
	body.maxLength = 8192;
	body.required = true;
	const color = element("input");
	color.value = action?.color ?? "";
	color.placeholder = "#RRGGBB";
	color.maxLength = 7;
	const palette = group();
	palette.classList.add("action-palette");
	let colorEdited = false;
	const swatches = [null, ...quickActionColors].map((value) => {
		const swatch = button(value ? "" : t.actionNeutral, () => {
			colorEdited = true;
			color.value = value ?? "";
			updateColors();
		});
		swatch.title = value ?? t.actionNeutral;
		swatch.setAttribute("aria-label", value ? `${t.actionColor} ${value}` : t.actionNeutral);
		colorAction(swatch, value);
		return [swatch, value] as const;
	});
	function updateColors(): void {
		for (const [swatch, value] of swatches)
			swatch.setAttribute("aria-pressed", String(color.value.toUpperCase() === (value ?? "")));
	}
	color.oninput = () => {
		colorEdited = true;
		updateColors();
	};
	updateColors();
	palette.append(...swatches.map(([swatch]) => swatch));
	const audience = action?.audience;
	const initialTargets: InstructionTarget[] =
		audience?.kind === "projects"
			? audience.ids.map((projectId) => ({ kind: "project", projectId }))
			: [{ kind: audience?.kind === "chat" ? "chat" : "global" }];
	const target = instructionTargetFields(form, () => {}, initialTargets);
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const save = taskSubmit(t.save, "primary");
	const footer = group(button(t.cancelInstructionEdit, goBackInPanel), save);
	const actionId = action?.id ?? newTaskId();
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation) return;
		const targets = target.targets();
		const kind = targets[0]?.kind;
		const selected =
			kind === "chat" || kind === "global"
				? { kind }
				: {
						kind: "projects",
						ids: targets.flatMap((item) => (item.kind === "project" ? [item.projectId] : [])),
					};
		const parsed = quickActionInput.safeParse({
			title: title.value.trim() || currentBody().trim().split(/\r?\n/u, 1)[0]?.slice(0, 48),
			body: currentBody(),
			audience: selected,
			color: color.value || null,
		});
		if (!parsed.success) {
			feedback.textContent = t.invalidComment;
			return;
		}
		const board = scope;
		form.inert = true;
		mutation = true;
		try {
			await call("save_action", {
				actionId,
				expectedRevision: action?.revision ?? 0,
				input: parsed.data,
				...(action?.title !== parsed.data.title || action?.body !== parsed.data.body
					? { optimize: { locale, suggestColor: !colorEdited && !parsed.data.color } }
					: {}),
			});
			if (form.isConnected && scope === board) dialog.close();
			void refreshActions();
		} catch {
			feedback.textContent = t.error;
		} finally {
			form.inert = false;
			finishMutation();
		}
	};
	if (action)
		footer.prepend(
			button(t.actionRemove, () => {
				dialogHeader(t.actionRemove);
				returnToPreviousView = () => showActionEditor(action);
				dialogContent.append(
					element("p", action.title),
					group(
						button(t.cancelInstructionEdit, goBackInPanel),
						button(t.actionRemove, async () => {
							if (await mutateAction("remove_action", { actionId, revision: action.revision }))
								dialog.close();
						}),
					),
				);
			}),
		);
	form.noValidate = true;
	form.append(
		field(t.actionTitle, title),
		field(t.actionText, body),
		target.section,
		field(t.actionColor, color),
		palette,
		feedback,
		footer,
	);
	dialogContent.append(form);
	body.focus();
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
		const { instructions, projectId } = await call<{
			instructions: PresentedInstruction[];
			projectId?: string;
		}>("instruction_library");
		if (scope !== board || generation !== instructionRequest) return;
		currentInstructionProject = projectId;
		const applicable = instructions.filter((entry) => entry.bindings?.some(appliesHere));
		const displayed = instructionHistory ? instructions : applicable;
		if (
			deferredInstruction &&
			!instructions.some(
				(entry) => entry.id === deferredInstruction && !entry.reformulation && !entry.reformulationPending,
			)
		)
			deferredInstruction = undefined;
		instructionNotice.textContent = deferredInstruction
			? t.instructionModelBusy
			: displayed.length
				? ""
				: t.instructionsEmpty;
		instructionTab.textContent = applicable.length
			? `${t.instructions} ${applicable.length}`
			: t.instructions;
		const signature = JSON.stringify([displayed, instructionHistory, instructionProjects]);
		if (signature === instructionSignature) {
			restorePanelScroll(1);
			return;
		}
		instructionSignature = signature;
		const active = document.activeElement?.closest<HTMLElement>("[data-instruction-id]");
		const action =
			document.activeElement instanceof HTMLElement
				? document.activeElement.dataset.instructionAction
				: undefined;
		instructionList.replaceChildren(
			...displayed.map((entry) => {
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
				const badges = instructionBadges(entry);
				copy.append(line);
				if (instructionHistory && entry.bindings?.length === 0) {
					const remove = button(
						t.deleteInstruction,
						() => confirmInstructionDeletion(entry, false),
						"instruction-delete",
					);
					remove.setAttribute("aria-label", `${t.deleteInstruction} · ${title}`);
					remove.dataset.instructionAction = "delete";
					const actions = group(badges, remove);
					actions.classList.add("instruction-history-actions");
					copy.append(actions);
				} else copy.append(badges);
				if (instructionHistory && entry.createdAt !== undefined)
					copy.append(element("time", dateFormat.format(entry.createdAt), "meta"));
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
		restorePanelScroll(1);
	} catch {
		if (scope === board && generation === instructionRequest) instructionNotice.textContent = t.error;
	}
}

function showInstructionDetails(entry: PresentedInstruction): void {
	dialogHeader(instructionTitle(entry), false, true);
	const content = element("section", undefined, "instruction-reading");
	const formatted = entry.reformulation?.body;
	const body = formatted && keepsMarkdownLinks(entry.body, formatted) ? formatted : entry.body;
	content.append(element("h3", t.instructionContent), markdownBlock(body));
	dialogContent.append(instructionBadges(entry), content);
	const bindings = element("div", undefined, "instruction-bindings");
	for (const binding of entry.bindings ?? []) {
		if (binding.kind === "other_chat") continue;
		const label = instructionBindingName(binding);
		const remove = button(t.detachInstruction, () => void detachInstruction(entry, binding));
		remove.setAttribute("aria-label", `${t.detachInstruction} · ${label}`);
		bindings.append(group(element("span", label, "meta"), remove));
	}
	const feedback = element("p", undefined, "notice");
	feedback.dataset.instructionFeedback = "";
	feedback.setAttribute("role", "status");
	if (instructionHistory && entry.bindings?.length === 0) {
		const unbound = element("section", undefined, "instruction-reading");
		unbound.append(element("h3", t.instructionAssignments(0)));
		dialogContent.append(unbound);
	}
	dialogContent.append(bindings, feedback);
	if (entry.reformulation) {
		const original = element("details", undefined, "revision-original");
		original.append(element("summary", t.originalText), originalBlock(entry.body));
		dialogContent.append(original);
	}
	dialogContent.append(
		group(
			button(t.edit, () => {
				showInstructionEditor(entry);
				returnToPreviousView = () => showInstructionDetails(entry);
			}),
			button(t.attachInstruction, () => showInstructionAssignment(entry)),
			...(instructionHistory && entry.bindings?.length === 0
				? [button(t.deleteInstruction, () => confirmInstructionDeletion(entry), "instruction-delete")]
				: []),
		),
	);
}

function confirmInstructionDeletion(entry: PresentedInstruction, fromDetails = true): void {
	dialogHeader(t.deleteInstructionTitle, false, true);
	if (fromDetails) returnToPreviousView = () => showInstructionDetails(entry);
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const cancel = button(t.cancelInstructionEdit, goBackInPanel);
	const confirm = button(t.deleteInstructionConfirm, () => void remove(), "instruction-delete-confirm");
	const actions = group(cancel, confirm);
	actions.classList.add("instruction-actions");
	dialogContent.append(
		element("p", instructionTitle(entry), "instruction-delete-name"),
		element("p", t.deleteInstructionHelp, "instruction-hint"),
		feedback,
		actions,
	);
	cancel.focus();
	async function remove(): Promise<void> {
		if (mutation) return;
		const board = scope;
		mutation = true;
		confirm.disabled = true;
		try {
			await call("delete_unbound_instruction", { entryId: entry.id, expectedRevision: entry.revision });
			if (scope !== board) return;
			dialog.close();
			showSuccessNotice(instructionFeedback, t.instructionDeleted);
			void refreshInstructions();
		} catch (error) {
			feedback.textContent =
				error instanceof Error && error.message === "conflict" ? t.deleteInstructionConflict : t.error;
		} finally {
			confirm.disabled = false;
			finishMutation();
		}
	}
}

function showInstructionAssignment(entry: PresentedInstruction): void {
	dialogHeader(t.attachInstruction, false, true);
	returnToPreviousView = () => showInstructionDetails(entry);
	const form = element("form");
	const save = taskSubmit(t.applyInstruction, "primary");
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	const selection = instructionTargetFields(form, () => {
		save.disabled = form.inert || selection.targets().length === 0;
	});
	const actions = group(button(t.cancelInstructionEdit, goBackInPanel), save);
	actions.classList.add("instruction-actions");
	form.append(selection.section, feedback, actions);
	dialogContent.append(element("p", instructionTitle(entry)), form);
	selection.fill();
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation || save.disabled) return;
		const board = scope;
		mutation = true;
		form.inert = true;
		try {
			await call("instruction_binding", {
				entryId: entry.id,
				expectedRevision: entry.revision,
				bindings: selection.targets(),
				active: true,
			});
			if (scope === board) {
				dialog.close();
				void refreshInstructions();
			}
		} catch {
			feedback.textContent = t.error;
		} finally {
			form.inert = false;
			finishMutation();
		}
	};
}

async function detachInstruction(entry: PresentedInstruction, binding: InstructionTarget): Promise<void> {
	if (mutation) return;
	const board = scope;
	mutation = true;
	try {
		const changed = await call<{ entryId: string; revision: number }>("instruction_binding", {
			entryId: entry.id,
			expectedRevision: entry.revision,
			bindings: [binding],
			active: false,
		});
		if (scope === board) {
			dialog.close();
			const undo = button(t.cancelInstructionEdit, () => void restore());
			instructionFeedback.replaceChildren(element("span", t.instructionDetached), undo);
			async function restore(): Promise<void> {
				if (mutation || scope !== board) return;
				mutation = true;
				undo.disabled = true;
				try {
					await call("instruction_binding", {
						entryId: changed.entryId,
						expectedRevision: changed.revision,
						bindings: [binding],
						active: true,
					});
					if (scope === board) {
						instructionFeedback.replaceChildren();
						void refreshInstructions();
					}
				} catch {
					if (scope === board) instructionFeedback.prepend(element("span", t.error));
				} finally {
					undo.disabled = false;
					finishMutation();
				}
			}
			void refreshInstructions();
		}
	} catch {
		instructionNotice.textContent = t.error;
		dialogContent.querySelector("[data-instruction-feedback]")?.replaceChildren(t.error);
	} finally {
		finishMutation();
	}
}

function instructionTargetFields(
	form: HTMLFormElement,
	onChange: () => void,
	initialTargets: InstructionTarget[] = [{ kind: "chat" }],
	onUserChange: () => void = () => {},
) {
	const choices = element("fieldset", undefined, "instruction-audience");
	const segments = element("div", undefined, "instruction-segments");
	choices.append(element("legend", t.instructionScope), segments);
	const kind = initialTargets[0]?.kind;
	const singleAudience = kind && initialTargets.every((target) => target.kind === kind);
	const audience = singleAudience
		? kind === "global"
			? "all"
			: kind === "project"
				? "project"
				: "chat"
		: "";
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
	const projectCount = element("span", undefined, "instruction-project-count");
	projectCount.setAttribute("role", "status");
	const selectAll = button(t.instructionSelectAll, () => selectProjects(true));
	const clearAll = button(t.instructionClearAll, () => selectProjects(false));
	const projectActions = group(selectAll, clearAll);
	projectActions.classList.add("instruction-project-actions");
	const projectToolbar = group(projectCount, projectActions);
	projectToolbar.classList.add("instruction-project-toolbar");
	projectField.append(element("legend", t.instructionProject), projectToolbar, projectRows);
	const projectStatus = element("p", t.noInstructionProjects, "instruction-project-empty");
	projectStatus.setAttribute("role", "status");
	const target = element("div", undefined, "instruction-scope");
	target.append(choices, scopeHint, projectField, projectStatus);
	const selectedProjects = new Set(
		initialTargets.flatMap((target) => (target.kind === "project" ? [target.projectId] : [])),
	);
	const projectInputs = () => projectRows.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
	function selectProjects(checked: boolean): void {
		onUserChange();
		selectedProjects.clear();
		for (const option of projectInputs()) {
			option.checked = checked;
			if (checked) selectedProjects.add(option.value);
		}
		updateProjectField();
	}
	const selectedAudience = () => new FormData(form).get("audience") ?? audience;
	const updateProjectField = () => {
		const scope = selectedAudience();
		const active = scope === "project";
		const options = projectInputs();
		const available = options.length > 0;
		const count = selectedProjects.size;
		const overBulkLimit = options.length > MAX_INSTRUCTION_TARGETS;
		projectCount.textContent = t.instructionSelectedProjects(count, options.length);
		selectAll.disabled = !available || count === options.length || overBulkLimit;
		clearAll.disabled = count === 0;
		for (const option of options) option.disabled = !option.checked && count >= MAX_INSTRUCTION_TARGETS;
		projectField.hidden = !(active && available);
		projectField.disabled = !active;
		projectStatus.hidden = !active || available;
		scopeHint.textContent =
			scope === ""
				? t.instructionChooseScope
				: scope === "chat"
					? t.instructionScopeChat
					: scope === "all"
						? t.instructionScopeAll
						: overBulkLimit
							? t.instructionProjectLimit(MAX_INSTRUCTION_TARGETS)
							: t.instructionScopeProject;
		onChange();
	};
	const fillProjects = () => {
		if (projectField.contains(document.activeElement)) return;
		projectRows.replaceChildren(
			...instructionProjects.map(({ id, name, chatCount }) => {
				const option = element("input");
				option.type = "checkbox";
				option.name = "project";
				option.value = id;
				option.checked = selectedProjects.has(id);
				option.onchange = () => {
					onUserChange();
					if (option.checked) selectedProjects.add(id);
					else selectedProjects.delete(id);
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
	choices.onchange = () => {
		onUserChange();
		updateProjectField();
	};
	void refreshInstructionProjects().then(() => {
		if (form.isConnected) fillProjects();
	});
	return {
		section: target,
		fill: fillProjects,
		targets: (): InstructionTarget[] => {
			const audience = selectedAudience();
			if (audience === "") return [];
			if (audience === "project")
				return [...selectedProjects].map((projectId) => ({ kind: "project", projectId }));
			return [{ kind: audience === "all" ? "global" : "chat" }];
		},
	};
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
	const save = taskSubmit(t.save, "primary");
	let importing = false;
	const updateSave = () => {
		save.disabled = importing || form.inert || ((!entry || scopeTouched) && !selection.targets().length);
	};
	const existingTargets = (entry?.bindings ?? []).filter((binding) => binding.kind !== "other_chat");
	let scopeTouched = false;
	const selection = instructionTargetFields(form, updateSave, entry ? existingTargets : undefined, () => {
		scopeTouched = true;
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

	actions.append(buttons);
	form.append(textField);
	form.append(selection.section);
	form.append(actions);
	dialogContent.append(form);
	selection.fill();
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
			updateSave();
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
		if (mutation || importing || save.disabled) return;
		const board = scope;
		const selected = selection.targets();
		const scopeEdited =
			scopeTouched &&
			(selected.length !== existingTargets.length ||
				selected.some(
					(target) => !existingTargets.some((initial) => JSON.stringify(initial) === JSON.stringify(target)),
				));
		const checked = instructionEntryWrite.safeParse({
			entryId,
			expectedRevision: entry?.revision ?? 0,
			body: readDraft(),
			permanent: false,
			targets: !entry || scopeEdited ? selected : [],
			...(entry && scopeEdited ? { replaceTargetsFrom: existingTargets } : {}),
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
			updateSave();
		}
	};
}

async function fetchDetails(taskId: string, view: "details" | "edit" | "unblock" = "details"): Promise<void> {
	dialogHeader(t.loading, view === "details");
	const currentHeading = dialogContent.querySelector("h2");
	try {
		const task = await call<PanelDetail>("get", { taskId });
		if (dialog.open && currentHeading?.isConnected) {
			if (view === "edit") showEditor(task);
			else if (view === "unblock" && task.state === "blocked") showUnblock(task, false);
			else showDetails(task);
		}
	} catch {
		if (currentHeading?.isConnected) currentHeading.textContent = t.error;
	}
}

interface DiscussionDraft {
	text: string;
	focused: boolean;
	files: readonly File[];
	pending: { body: string; files: readonly File[]; id: string } | undefined;
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
	dialogContent.firstElementChild?.append(metadata, renderTaskDates(task, true));
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
		mainActions.append(button(t.resolveBlocker, () => showUnblock(task, true, readDiscussionDraft?.())));
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

function showUnblock(task: PanelDetail, fromDetail: boolean, draft?: DiscussionDraft): void {
	if (mutation) return;
	dialogHeader(t.unblockTitle);
	const response = element("textarea");
	response.maxLength = 1200;
	const form = element("form");
	form.setAttribute("aria-labelledby", "task-dialog-title");
	const confirm = taskSubmit(t.confirmUnblock, "primary");
	const feedback = element("p", undefined, "notice");
	feedback.setAttribute("role", "status");
	if (fromDetail) returnToPreviousView = () => showDetails(task, draft);
	form.append(
		element("p", task.title, "meta"),
		...(task.receipt ? [markdownBlock(task.receipt)] : []),
		element("p", t.unblockDescription),
		field(t.unblockResponse, response),
		group(button(t.cancelUnblock, goBackInPanel), confirm),
		feedback,
	);
	const commentId = newTaskId();
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (mutation) return;
		mutation = true;
		form.inert = true;
		const board = scope;
		try {
			const updated = await call<Task & { wake: boolean }>("unblock", {
				taskId: task.id,
				expectedSerial: task.serial,
				response: response.value,
				commentId,
				locale,
			});
			if (scope !== board) return;
			if (fromDetail) showDetails(updated, draft);
			else dialog.close();
			void refresh(true);
			if (updated.wake && app.getHostCapabilities()?.message?.text) void resumeChat();
		} catch (error) {
			feedback.textContent = error instanceof Error && error.message === "conflict" ? t.unsigned : t.error;
		} finally {
			form.inert = false;
			finishMutation();
			if (form.isConnected) response.focus();
		}
	};
	dialogContent.append(form);
	response.focus();
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
				if (draft?.text.trim() || draft?.files.length || draft?.pending) returnToDetail(updated);
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

type PanelComment = TaskComment & { formatting?: boolean };

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
	input.maxLength = MAX_COMMENT_BYTES;
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
	const stored = new Map<number, PanelComment>();
	let cursor: number | null = null;
	let loading = false;
	let loaded = false;
	let latestOrdinal: number | undefined;
	let draft = savedDraft?.pending;
	let commentFiles = savedDraft?.files ?? [];
	const fileList = element("ul", undefined, "comment-files");
	const imagePreviews = new IntersectionObserver((entries, observer) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			observer.unobserve(entry.target);
			entry.target.querySelector("button")?.click();
		}
	});
	let blocker: TaskComment | undefined;
	function renderComments(): void {
		const entries = [...stored.values(), ...(blocker ? [blocker] : [])].sort(
			(a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal,
		);
		imagePreviews.disconnect();
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
				message.append(group(element("strong", label), timestamp));
				if (comment.body) message.append(markdownBlock(comment.body));
				if ("formatting" in comment && comment.formatting)
					message.append(element("small", t.commentFormatting, "meta"));
				for (const file of comment.attachments ?? []) {
					const fileDetails = element("div", undefined, "comment-attachment");
					const attachment = attachmentView(file, () => {
						attachment.remove();
						void preview(task.id, file, fileDetails);
					});
					fileDetails.append(attachment);
					message.append(fileDetails);
					if (safeImages.has(file.mime)) imagePreviews.observe(fileDetails);
				}
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
				Omit<CommentsPage, "comments"> & {
					comments: PanelComment[];
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
						files: commentFiles,
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
				const previous = stored.get(comment.ordinal);
				if (!previous || previous.body !== comment.body || previous.formatting !== comment.formatting)
					changed = true;
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
	function renderDraftFiles(): void {
		fileList.replaceChildren(
			...commentFiles.map((file) => {
				const row = element("li", undefined, "group");
				if (safeImages.has(file.type)) {
					const image = element("img");
					image.alt = `${t.preview} · ${file.name}`;
					const url = URL.createObjectURL(file);
					image.onload = () => URL.revokeObjectURL(url);
					image.onerror = () => {
						URL.revokeObjectURL(url);
						image.remove();
					};
					image.src = url;
					row.append(image);
				}
				const erase = button(t.remove, () => {
					if (post.disabled) return;
					commentFiles = commentFiles.filter((current) => current !== file);
					renderDraftFiles();
					input.focus();
				});
				erase.setAttribute("aria-label", `${t.remove} · ${file.name}`);
				row.append(element("span", file.name), erase);
				return row;
			}),
		);
	}
	function addCommentContext(context: TransferredContext): void {
		if (post.disabled) return;
		const files = [...commentFiles, ...context.files];
		try {
			validateFiles(files);
		} catch {
			feedback.textContent = t.fileError;
			return;
		}
		if (context.text) {
			const start = input.selectionStart;
			const end = input.selectionEnd;
			const next = input.value.slice(0, start) + context.text + input.value.slice(end);
			if (byteLength(next) > MAX_COMMENT_BYTES) {
				feedback.textContent = t.invalidComment;
				return;
			}
			input.setRangeText(context.text, start, end, "end");
		}
		if (context.files.length) {
			commentFiles = files;
			renderDraftFiles();
		}
		feedback.textContent = "";
		input.focus();
	}
	form.onsubmit = async (event) => {
		event.preventDefault();
		if (post.disabled) return;
		const body = input.value;
		if (!body.trim() && !commentFiles.length) {
			feedback.textContent = t.addComment;
			return;
		}
		if (byteLength(body) > MAX_COMMENT_BYTES) {
			feedback.textContent = t.invalidComment;
			return;
		}
		if (draft?.body !== body || draft.files !== commentFiles)
			draft = { body, files: commentFiles, id: newTaskId() };
		post.disabled = true;
		input.readOnly = true;
		try {
			const content = commentContent.parse({ body, files: await encodeFiles(commentFiles) });
			const board = scope;
			const published = await call<PanelComment & { wake?: boolean }>("comment", {
				taskId: task.id,
				commentId: draft.id,
				...content,
				format: true,
			});
			draft = undefined;
			if (section.isConnected && dialog.open) {
				input.value = "";
				commentFiles = [];
				renderDraftFiles();
				stored.set(published.ordinal, published);
				renderComments();
				input.focus({ preventScroll: true });
				showSuccessNotice(feedback, t.commentPublished);
			}
			if (published.wake && scope === board && app.getHostCapabilities()?.message?.text)
				void resumeChat("comment");
		} catch {
			feedback.textContent = t.error;
			if (section.isConnected && dialog.open) input.focus();
		} finally {
			post.disabled = false;
			input.readOnly = false;
		}
	};
	async function addDroppedCommentContext(context: TransferredContext): Promise<void> {
		const markdown = context.files.filter(
			(file) => /\.(?:md|markdown)$/i.test(file.name) && file.size <= MAX_COMMENT_BYTES,
		);
		if (!markdown.length) {
			addCommentContext(context);
			return;
		}
		post.disabled = true;
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const parts = await Promise.all(markdown.map(async (file) => decoder.decode(await file.arrayBuffer())));
			if (parts.some((text) => text.includes("\0"))) throw new Error(t.fileRead);
			post.disabled = false;
			if (dialog.open && section.isConnected)
				addCommentContext({
					text: [context.text, ...parts].filter(Boolean).join("\n\n"),
					files: context.files.filter((file) => !markdown.includes(file)),
				});
		} catch {
			if (section.isConnected) feedback.textContent = t.fileRead;
		}
	}
	installDropSurface(
		form,
		(context) => void addDroppedCommentContext(context),
		() => !post.disabled,
	);
	form.addEventListener("dragover", (event) => event.stopPropagation());
	form.addEventListener("drop", (event) => event.stopPropagation());
	form.onpaste = (event) => {
		event.stopPropagation();
		if (!event.clipboardData?.files.length) return;
		event.preventDefault();
		addCommentContext(captureContext(event.clipboardData));
	};
	form.append(
		field(t.addComment, input),
		element("p", t.contextTarget, "drop-zone comment-drop-hint"),
		element("p", t.dropCommentFiles, "drop-zone comment-drop-message"),
		fileList,
		feedback,
	);
	renderDraftFiles();
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
		files: commentFiles,
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
	const body =
		formatted && keepsMarkdownLinks(revision.body, formatted.body) ? formatted.body : revision.body;
	if (body) section.append(markdownBlock(body));
	if (formatted) {
		const original = element("details", undefined, "revision-original");
		const raw = revision.body ? `${revision.title}\n\n${revision.body}` : revision.title;
		original.append(element("summary", t.originalText), originalBlock(raw));
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
				if (added.wake && app.getHostCapabilities()?.message?.text) void resumeChat("task");
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
				void refresh(true);
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
					if (result.wake && scope === board) void resumeChat("task");
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
	() => !taskPanel.hidden,
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
		taskPanel.hidden ||
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

app.ontoolresult = async (result) => {
	const binding = id.safeParse(result._meta?.binding);
	if (!binding.success) return;
	if (scope === binding.data) {
		if (!viewReady) return;
		void refreshActions();
		if (!dialog.open && !taskPanel.hidden) void refresh(true);
		if (!dialog.open && !instructionPanel.hidden) void refreshInstructions();
		return;
	}
	flushPanelViewScroll();
	scope = binding.data;
	const initialBinding = ++viewBindingGeneration;
	viewReady = false;
	viewWritable = false;
	viewSignature = "";
	savedScroll = undefined;
	refreshGeneration++;
	refreshing = false;
	instructionRequest++;
	dialog.close();
	for (const tab of tabs) tab.disabled = true;
	add.disabled = true;
	actionAdd.disabled = true;
	actionSignature = "";
	actionShelf.hidden = true;
	actionButtons.replaceChildren();
	actionList.replaceChildren();
	actionFeedback.textContent = "";
	actionLibraryFeedback.textContent = "";
	recentActions.clear();
	instructionAdd.disabled = true;
	instructionSignature = "";
	deferredInstruction = undefined;
	instructionProjects = [];
	currentInstructionProject = undefined;
	instructionTab.textContent = t.instructions;
	quickInstruction.value = "";
	unsavedInstruction = undefined;
	instructionList.replaceChildren();
	instructionFeedback.replaceChildren();
	quickTitle.disabled = true;
	quickSubmit.disabled = true;
	for (const { toggle } of filterButtons) toggle.disabled = true;
	lastAgentOrdinal = undefined;
	previousAfter = null;
	next = null;
	pageHistory.length = 0;
	boardList.scrollTop = 0;
	instructionScroll.scrollTop = 0;
	actionList.scrollTop = 0;
	rows.replaceChildren();
	current = [];
	lastRender = "";
	await viewWrites;
	if (initialBinding !== viewBindingGeneration) return;
	let saved: BoardPanelView | null | undefined;
	try {
		const { view } = await call<{ view: unknown }>("view", {}, 3000);
		const parsed = boardPanelView.nullable().safeParse(view);
		if (parsed.success) saved = parsed.data;
	} catch {
		// An older or transiently unavailable MCP server still opens the board with defaults.
	}
	if (initialBinding !== viewBindingGeneration) return;
	viewWritable = saved !== undefined;
	applyFilters(saved?.filters ?? []);
	applyInstructionHistory(saved?.instructionHistory ?? false);
	cursor = saved?.cursor ?? 0;
	if (saved) {
		savedScroll = { tab: saved.tab, top: saved.scrollTop };
		viewSignature = JSON.stringify(saved);
	}
	selectBoardTab(saved?.tab ?? 0, true);
	viewReady = true;
	for (const tab of tabs) tab.disabled = false;
	add.disabled = false;
	actionAdd.disabled = false;
	instructionAdd.disabled = false;
	quickTitle.disabled = false;
	quickSubmit.disabled = false;
	for (const { toggle } of filterButtons) toggle.disabled = false;
	void refreshActions();
	if (!taskPanel.hidden) void refresh(true, !saved);
	if (!instructionPanel.hidden) void refreshInstructionProjects().then(refreshInstructions);
};
function updateHostStyle(context?: McpUiHostContext): void {
	if (context?.theme) applyDocumentTheme(context.theme);
	if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.onhostcontextchanged = updateHostStyle;
app.onteardown = async () => {
	flushPanelViewScroll();
	await viewWrites;
	return {};
};
try {
	await app.connect();
	updateHostStyle(app.getHostContext());
	if (!scope) notice.textContent = t.connect;
} catch {
	notice.textContent = t.error;
}
const timer = window.setInterval(() => {
	if (document.hidden || mutation || !viewReady) return;
	void refreshActions();
	if (dialog.open) void refreshDiscussion?.();
	else if (!taskPanel.hidden) void refresh();
	else if (!instructionPanel.hidden) void refreshInstructions();
}, POLL_MS);
window.addEventListener(
	"pagehide",
	() => {
		window.clearInterval(timer);
		flushPanelViewScroll();
	},
	{ once: true },
);
