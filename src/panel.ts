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
import { type Attachment, id, MAX_PAGE, type Revision, type Task, type TaskSummary } from "./contract.ts";
import { catalog } from "./messages.ts";
import type { BoardList } from "./repository.ts";

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

async function createTask(command: Record<string, unknown>): Promise<Task> {
	const board = scope;
	const saved = await call<Task & { wake?: boolean }>("create", command);
	if (scope === board && saved.wake && app.getHostCapabilities()?.message?.text) {
		void resumeChat();
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
		if (showCancelled) switchList(false);
		else await refresh(true);
	} catch {
		notice.textContent = t.error;
	} finally {
		quickSubmit.disabled = false;
		finishMutation();
	}
};
const active = button(t.active, () => switchList(false));
const cancelled = button(t.cancelled, () => switchList(true));
active.disabled = true;
cancelled.disabled = true;
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
const filters = group(active, cancelled, resume);
filters.classList.add("board-filters");
const heading = group(group(element("h1", t.heading), progressText), add);
heading.classList.add("heading");
main.append(
	heading,
	progressGroup,
	quickAdd,
	transferNotice,
	notice,
	rows,
	filters,
	dropZone,
	pageNavigation,
);
document.documentElement.lang = locale;
document.body.append(main, dialog);

let showCancelled = false;
let next: number | null = null;
let cursor = 0;
const pageHistory: number[] = [];
let current: TaskSummary[] = [];
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

function switchList(value: boolean): void {
	showCancelled = value;
	active.setAttribute("aria-pressed", String(!value));
	cancelled.setAttribute("aria-pressed", String(value));
	cursor = 0;
	pageHistory.length = 0;
	resetPage();
}

function resetPage(): void {
	current = [];
	next = null;
	lastRender = "";
	rows.replaceChildren();
	more.hidden = true;
	previous.hidden = pageHistory.length === 0;
	notice.textContent = t.loading;
	void refresh(true);
}

async function resumeChat(): Promise<void> {
	if (resume.disabled) return;
	resume.disabled = true;
	try {
		const response = await app.sendMessage(
			{ role: "user", content: [{ type: "text", text: t.resumePrompt }] },
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
		const page = await call<BoardList>("list", { after: cursor, cancelled: showCancelled });
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

function render(counts: BoardList["counts"]): void {
	const total = counts.queued + counts.running + counts.blocked + counts.done;
	progressGroup.hidden = total === 0;
	progress.max = Math.max(1, total);
	progress.value = counts.done;
	progressText.textContent = total ? `${counts.done}/${total}` : "";
	progressText.setAttribute("aria-label", t.completed({ done: counts.done, total }));
	more.hidden = next === null;
	resume.hidden = counts.queued === 0 || !app.getHostCapabilities()?.message?.text;
	notice.textContent = current.length ? "" : showCancelled ? t.emptyCancelled : t.empty;
	const signature = JSON.stringify(current.map(({ id, serial }) => [id, serial]));
	if (signature === lastRender) return;
	lastRender = signature;
	const focusedTask = rows.contains(document.activeElement) ? dropTaskId(document.activeElement) : undefined;
	rows.replaceChildren(...current.map(renderTask));
	if (focusedTask)
		rows
			.querySelector<HTMLButtonElement>(`[data-task-id="${CSS.escape(focusedTask)}"] .task-title`)
			?.focus({ preventScroll: true });
}

function renderTask(task: TaskSummary): HTMLLIElement {
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
	const executor = task.assignee === "thread" || !task.assignee ? "" : task.assignee;
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
	dialog.dataset.layout = fullPane ? "pane" : "dialog";
	dialogContent.ondragover = null;
	dialogContent.ondragleave = null;
	dialogContent.ondrop = null;
	dialogContent.onpaste = null;
	dialogContent.classList.remove("drop-armed");
	const heading = element("h2", title);
	heading.id = "task-dialog-title";
	const back = button("‹", () => dialog.close(), "icon-button back");
	back.setAttribute("aria-label", t.close);
	dialogContent.replaceChildren(group(back, heading));
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

function showDetails(task: Task): void {
	dialogHeader(task.title, true);
	const detailsState = element(
		"p",
		t[task.state === "cancelled" ? "cancelledState" : task.state],
		"detail-state",
	);
	detailsState.dataset.state = task.state;
	dialogContent.append(detailsState);
	const executor = task.assignee === "thread" || !task.assignee ? "" : task.assignee;
	const execution = group(
		element("span", t.delegation),
		element("span", executor ? `${t[task.mode]} → ${executor}` : t[task.mode], "execution"),
	);
	execution.classList.add("task-meta");
	dialogContent.append(execution);
	if (task.body || task.attachments.length) {
		dialogContent.append(element("h3", t.currentVersion), renderRevision(task, task, false));
	}
	if (task.receipt && !task.verification) dialogContent.append(element("p", task.receipt, "notice"));
	if (task.verification) {
		const proof = element("dl", undefined, "verification");
		for (const [label, value] of [
			[t.workPerformed, task.verification.work],
			[t.checkPerformed, task.verification.check],
			[t.checkResult, task.verification.result],
			[t.checkEvidence, task.verification.evidence],
		] as const) {
			proof.append(element("dt", label), element("dd", value));
		}
		dialogContent.append(proof);
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
	if (task.state === "cancelled" || task.state === "blocked")
		actions.append(button(t.restore, () => void updateTask("restore", task)));
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
			if (!event.clipboardData || !acceptsContext(event.clipboardData)) return;
			event.preventDefault();
			const context = captureContext(event.clipboardData);
			if (hasContext(context)) void saveDroppedContext(context, task.id, true);
		};
	}
	dialogContent.append(actions, history);
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

function attachmentView(file: Attachment, open: () => void): HTMLElement {
	return button(file.name, open, "attachment");
}

async function preview(taskId: string, file: Attachment): Promise<void> {
	const view = dialogContent;
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
	let manualTitle = false;
	const titleFromBody = () =>
		body.value.trim() ? contextTitle({ files: [], text: body.value }, t.newTask) : "";
	const suggestTitle = () => {
		if (task) return;
		const suggestion = titleFromBody();
		title.required = !suggestion;
		if (!manualTitle) title.value = suggestion;
	};
	title.oninput = () => {
		manualTitle = Boolean(title.value.trim());
	};
	body.oninput = suggestTitle;
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
		suggestTitle();
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
		mutation = true;
		save.disabled = true;
		form.inert = true;
		savingStatus.textContent = t.saving;
		status.textContent = "";
		try {
			const input = {
				title: title.value.trim() || titleFromBody(),
				body: body.value,
				mode: mode.value,
				keep: attachments.keep(),
				files: await attachments.encode(),
			};
			if (task) await call("edit", { taskId, input, expectedRevision: task.revision });
			else await createTask({ taskId, input });
			dialog.close();
			void refresh(true);
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
					...(task ? { expectedRevision: task.revision } : {}),
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
			const saved = taskId ? await call<Task>("edit", command) : await createTask(command);
			transferMessage(taskId ? t.contextAdded : t.taskAdded);
			if (!taskId) {
				switchList(false);
				if (!dialog.open) showEditor(saved, true);
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

installDropSurface(main, (context, event) => void saveDroppedContext(context, dropTaskId(event.target)));
document.addEventListener("paste", (event) => {
	if (!scope || dialog.open || !event.clipboardData || !acceptsContext(event.clipboardData)) return;
	const context = captureContext(event.clipboardData);
	if (!hasContext(context)) return;
	event.preventDefault();
	void saveDroppedContext(context, dropTaskId(event.target));
});

app.ontoolresult = (result) => {
	const binding = id.safeParse(result._meta?.binding);
	if (!binding.success || scope === binding.data) return;
	scope = binding.data;
	add.disabled = false;
	quickTitle.disabled = false;
	quickSubmit.disabled = false;
	active.disabled = false;
	cancelled.disabled = false;
	switchList(false);
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
	if (!document.hidden && !dialog.open && !mutation) void refresh();
}, POLL_MS);
window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
