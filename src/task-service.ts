/** Task commands and revision-aware work ownership. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CodexProjects } from "./codex-projects.ts";
import {
	type Actor,
	appendContextText,
	type BoardFilter,
	type BoardInstructions,
	type BoardNote,
	boardNote,
	commentBody,
	commentContent,
	type InstructionChanges,
	type InstructionEntryWrite,
	type InstructionMoment,
	type InstructionTarget,
	instructionChanges,
	instructionEntryWrite,
	instructionTargets,
	MAX_FILE_BYTES,
	MAX_UPLOAD_BYTES,
	manualCheck,
	type PresentedInstruction,
	type Reformulation,
	type Revision,
	reformulation,
	resumeCode,
	type Task,
	type TaskComment,
	TaskError,
	type TaskInput,
	taskInput,
	type Verification,
	verification,
} from "./contract.ts";
import type { BoardList, CommentsPage, StoredFile, TaskRepository, TaskStatus } from "./repository.ts";

const inactive = (state: "queued" | "cancelled"): TaskStatus => ({
	state,
	assignee: null,
	claim: null,
	receipt: null,
});
const RESUME_TTL_MS = 30_000;

function hashResumeCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}
interface VersionedTask {
	scope: string;
	taskId: string;
	expectedSerial: number;
}
interface RevisionEdit {
	scope: string;
	taskId: string;
	expectedRevision: number;
}
interface Claim extends VersionedTask {
	assignee: string;
}
interface Settlement {
	scope: string;
	taskId: string;
	claimId: string;
	state: "done" | "blocked" | "queued";
	receipt?: string | undefined;
	verification?: Verification | undefined;
}

interface TaskCreation {
	task: Task;
	created: boolean;
	wakeThreadId?: string;
}

/** Decodes bounded file contents before opening a database transaction. */
function decodeFiles(input: Pick<TaskInput, "files">): StoredFile[] {
	let bytes = 0;
	return input.files.map((file) => {
		const data = Buffer.from(file.data, "base64");
		bytes += data.length;
		if (data.length > MAX_FILE_BYTES || bytes > MAX_UPLOAD_BYTES || data.toString("base64") !== file.data) {
			throw new TaskError("invalid_attachment");
		}
		return { id: randomUUID(), name: file.name, mime: file.mime, data };
	});
}

export class TaskService {
	constructor(
		private readonly store: TaskRepository,
		private readonly now: () => number = Date.now,
		private readonly projects?: CodexProjects,
	) {}

	/** Returns the task board capability issued to a trusted lifecycle hook. */
	bind(threadId: string): string {
		return this.store.bind(threadId);
	}

	readPanelView(scope: string): ReturnType<TaskRepository["readPanelView"]> {
		return this.store.readPanelView(scope);
	}

	savePanelView(scope: string, view: Parameters<TaskRepository["savePanelView"]>[1]): void {
		this.store.savePanelView(scope, view);
	}

	readNote(scope: string): BoardNote {
		return this.store.readNote(scope);
	}

	saveNote(scope: string, note: BoardNote): BoardNote {
		return this.writeNote(scope, note).note;
	}

	writeNote(scope: string, note: BoardNote): ReturnType<TaskRepository["saveNote"]> {
		const checked = boardNote.safeParse(note);
		if (!checked.success) throw new TaskError("invalid_context");
		return this.store.saveNote(scope, checked.data);
	}

	appendNote(scope: string, expectedRevision: number, body: string): BoardNote {
		const current = this.store.readNote(scope);
		if (current.revision !== expectedRevision) throw new TaskError("conflict");
		return this.saveNote(scope, {
			revision: expectedRevision,
			body: appendContextText(current.body, body),
		});
	}

	applyNoteFormat(scope: string, note: BoardNote, formatted: string): void {
		const checked = boardNote.shape.body.safeParse(formatted);
		if (checked.success && checked.data.trim() && checked.data !== note.body) {
			this.store.applyNoteFormat(scope, note, checked.data);
		}
	}

	/** Lists the current board without fetching any attachment bytes. */
	list(
		scope: string,
		after = 0,
		cancelled: boolean | BoardFilter | BoardFilter[] = false,
		formatted = false,
		viewport?: { tail: boolean },
	): BoardList {
		this.store.assertScope(scope);
		const filter = typeof cancelled === "boolean" ? (cancelled ? "cancelled" : "active") : cancelled;
		return this.store.list(scope, after, filter, formatted, viewport);
	}

	readInstructions(scope: string): BoardInstructions {
		return this.store.readInstructions(scope);
	}

	saveInstructions(scope: string, changes: InstructionChanges): BoardInstructions {
		const checked = instructionChanges.safeParse(changes);
		if (!checked.success) throw new TaskError("invalid_context");
		return this.store.saveInstructions(scope, checked.data);
	}

	listInstructionProjects(scope: string) {
		this.store.assertScope(scope);
		return this.projects?.list() ?? [];
	}

	listInstructionEntries(
		scope: string,
		presented = false,
		manageProjects = false,
		moment: InstructionMoment = "turn",
	): PresentedInstruction[] {
		const projectId = presented ? undefined : this.projects?.forThread(this.store.threadForScope(scope));
		return this.store.listInstructionEntries(
			scope,
			presented,
			projectId,
			manageProjects,
			false,
			presented ? undefined : moment,
		);
	}

	saveInstructionEntry(
		scope: string,
		input: InstructionEntryWrite,
		materializeLegacy = false,
		manageProjects = false,
	): PresentedInstruction {
		const checked = instructionEntryWrite.safeParse(input);
		if (!checked.success) throw new TaskError("invalid_context");
		const projects =
			checked.data.targets?.flatMap((target) => (target.kind === "project" ? [target.projectId] : [])) ??
			(checked.data.projectId ? [checked.data.projectId] : []);
		const audience = checked.data.targets?.[0];
		if (audience?.kind === "projects_except") {
			const available = this.listInstructionProjects(scope);
			if (
				!manageProjects ||
				(available.length && available.every(({ id }) => audience.projectIds.includes(id)))
			)
				throw new TaskError("invalid_context");
		}
		this.validateInstructionProjects(scope, projects, manageProjects);
		return this.store.saveInstructionEntry(
			scope,
			checked.data,
			materializeLegacy,
			manageProjects,
			this.now(),
		);
	}

	listInstructionLibrary(scope: string): PresentedInstruction[] {
		return this.store.listInstructionEntries(scope, true, undefined, true, true);
	}

	instructionProjectForScope(scope: string): string | undefined {
		return this.projects?.forThread(this.store.threadForScope(scope));
	}

	setInstructionBindings(
		scope: string,
		entryId: string,
		expectedRevision: number,
		bindings: InstructionTarget[],
		active: boolean,
	): { entryId: string; revision: number } {
		if (!instructionTargets.min(1).safeParse(bindings).success) throw new TaskError("invalid_context");
		if (active)
			this.validateInstructionProjects(
				scope,
				bindings.flatMap((binding) => (binding.kind === "project" ? [binding.projectId] : [])),
				true,
			);
		return this.store.setInstructionBindings(scope, entryId, expectedRevision, bindings, active);
	}

	private validateInstructionProjects(scope: string, projects: string[], manageProjects: boolean): void {
		if (!projects.length) return;
		const available = new Set(this.listInstructionProjects(scope).map((project) => project.id));
		if (!manageProjects || projects.some((project) => !available.has(project)))
			throw new TaskError("invalid_context");
	}

	saveInstructionReformulation(
		scope: string,
		entryId: string,
		revision: number,
		result: Reformulation,
		library = false,
	): void {
		const checked = reformulation.safeParse(result);
		if (checked.success)
			this.store.saveInstructionReformulation(scope, entryId, revision, checked.data, library);
	}

	deleteUnboundInstruction(scope: string, entryId: string, expectedRevision: number): void {
		this.store.deleteUnboundInstruction(scope, entryId, expectedRevision);
	}

	removeInstructionEntry(
		scope: string,
		entryId: string,
		expectedRevision: number,
		manageProjects = false,
	): void {
		this.store.removeInstructionEntry(scope, entryId, expectedRevision, manageProjects);
	}

	moveQueued(command: {
		scope: string;
		taskId: string;
		targetId: string;
		position: number;
		targetPosition: number;
	}): void {
		this.store.write(() => {
			const source = this.store.queuedPosition(command.scope, command.taskId);
			const target = this.store.queuedPosition(command.scope, command.targetId);
			if (source !== command.position || target !== command.targetPosition || source === target)
				throw new TaskError("conflict");
			this.store.moveQueued(command.scope, source, target);
		});
	}

	resumeOwner(scope: string, taskId: string): string | undefined {
		return this.requireTask(scope, taskId).state === "queued" ? this.store.threadForScope(scope) : undefined;
	}

	requestResume(scope: string): string | undefined {
		this.store.assertScope(scope);
		const code = randomBytes(16).toString("hex");
		const now = this.now();
		if (this.store.requestResume(scope, hashResumeCode(code), now, now + RESUME_TTL_MS)) return code;
	}

	consumeResume(scope: string, code: string): boolean {
		return (
			resumeCode.safeParse(code).success && this.store.consumeResume(scope, hashResumeCode(code), this.now())
		);
	}

	clearStopCheckpoint(scope: string): void {
		this.store.clearStopCheckpoint(scope);
	}

	clearFinishCheckpoint(scope: string): void {
		this.store.clearFinishCheckpoint(scope);
	}

	checkpointFinish(scope: string, turnId?: string): boolean {
		return this.store.checkpointFinish(scope, turnId);
	}

	checkpointStop(scope: string, continuation: boolean): ReturnType<TaskRepository["checkpointStop"]> {
		return this.store.checkpointStop(scope, continuation);
	}

	pendingNotifications(scope: string): { pendingComments?: true; pendingEdits?: true } {
		return {
			...(this.store.hasCommentNotifications(scope) ? { pendingComments: true } : {}),
			...(this.store.hasEditNotifications(scope) ? { pendingEdits: true } : {}),
		};
	}

	commentNotifications(scope: string): ReturnType<TaskRepository["commentNotifications"]> {
		this.store.assertScope(scope);
		return this.store.commentNotifications(scope);
	}

	acknowledgeComment(scope: string, ordinal: number): boolean {
		this.store.assertScope(scope);
		return this.store.acknowledgeComment(scope, ordinal);
	}

	nextEditNotification(scope: string): ReturnType<TaskRepository["nextEditNotification"]> {
		this.store.assertScope(scope);
		return this.store.nextEditNotification(scope);
	}

	acknowledgeEdit(scope: string, taskId: string, revision: number): boolean {
		this.store.assertScope(scope);
		return this.store.acknowledgeEdit(scope, taskId, revision);
	}

	/** Records an explicit human check on the current task without an agent claim. */
	validate(command: VersionedTask, observation: string): Task {
		const checked = manualCheck.safeParse(observation);
		if (!checked.success) throw new TaskError("verification_required");
		return this.mutate(command, (row) => {
			if (row.state === "done") {
				if (this.store.task(row).manualValidation) throw new TaskError("invalid_state");
				this.store.update(
					command.scope,
					command.taskId,
					row,
					{
						state: "done",
						assignee: row.assignee,
						claim: null,
						receipt: row.receipt,
					},
					this.now(),
				);
				this.store.saveUserValidation(command.taskId, row.serial + 1, checked.data);
				return;
			}
			if (row.state !== "queued" && row.state !== "blocked") throw new TaskError("invalid_state");
			this.store.update(
				command.scope,
				command.taskId,
				row,
				{
					state: "done",
					assignee: "user",
					claim: null,
					receipt: JSON.stringify({ userCheck: checked.data }),
				},
				this.now(),
			);
		});
	}

	/** Comments stay attached to the task without changing its instructions or work state. */
	comment(
		scope: string,
		taskId: string,
		commentId: string,
		body: string,
		author: Actor,
		files: TaskInput["files"] = [],
	): TaskComment {
		return this.insertComment(scope, taskId, commentId, body, author, files, false).comment;
	}

	commentFromPanel(
		scope: string,
		taskId: string,
		commentId: string,
		body: string,
		files: TaskInput["files"],
	): { comment: TaskComment; optimized: boolean; wakeThreadId?: string } {
		return this.insertComment(scope, taskId, commentId, body, "user", files, true);
	}

	private insertComment(
		scope: string,
		taskId: string,
		commentId: string,
		body: string,
		author: Actor,
		files: TaskInput["files"],
		notify: boolean,
	): { comment: TaskComment; optimized: boolean; wakeThreadId?: string } {
		const parsed = commentContent.safeParse({ body, files });
		if (!parsed.success) throw new TaskError("invalid_state");
		const decoded = decodeFiles(parsed.data);
		return this.store.write(() => {
			this.requireTask(scope, taskId);
			const firstPending = notify && !this.store.hasCommentNotifications(scope);
			const { comment, created, optimized } = this.store.addComment(
				taskId,
				commentId,
				author,
				"comment",
				body.trim() ? body : "",
				this.now(),
				decoded,
				notify,
			);
			return {
				comment,
				optimized,
				...(firstPending && created ? { wakeThreadId: this.store.threadForScope(scope) } : {}),
			};
		});
	}

	saveCommentReformulation(scope: string, taskId: string, commentId: string, body: string): void {
		this.requireTask(scope, taskId);
		const parsed = commentBody.safeParse(body);
		if (parsed.success) this.store.saveCommentReformulation(taskId, commentId, parsed.data);
	}

	comments(
		scope: string,
		taskId: string,
		before = Number.MAX_SAFE_INTEGER,
	): CommentsPage & { taskSerial: number } {
		const row = this.requireTask(scope, taskId);
		const page = this.store.comments(taskId, before);
		if (row.state === "blocked" && row.receipt)
			page.currentBlocker = {
				id: row.id,
				ordinal: 0,
				author: "agent",
				kind: "blocker",
				body: row.receipt,
				createdAt: row.updated_at,
			};
		return { ...page, taskSerial: row.serial };
	}

	/** Creates a queued task, using the client operation ID for replay protection. */
	create(scope: string, taskId: string, input: TaskInput, author: Actor): Task {
		return this.insert(scope, taskId, input, author, false).task;
	}

	/** Allows a wake only for the first addition to a drained board. */
	createFromPanel(scope: string, taskId: string, input: TaskInput): TaskCreation {
		return this.insert(scope, taskId, input, "user", true);
	}

	saveReformulation(scope: string, taskId: string, revision: number, generated: Reformulation): void {
		const checked = reformulation.safeParse(generated);
		if (checked.success) this.store.saveReformulation(scope, taskId, revision, checked.data);
	}

	readReformulation(task: Task): Reformulation | undefined {
		return this.store.readReformulation(task.id, task.revision);
	}

	saveGeneratedTitle(scope: string, taskId: string, title: string, split = false): void {
		this.store.saveGeneratedTitle(scope, taskId, title, split);
	}

	private insert(
		scope: string,
		taskId: string,
		input: TaskInput,
		author: Actor,
		wake: boolean,
	): TaskCreation {
		const files = decodeFiles(input);
		if (input.keep.length) throw new TaskError("invalid_attachment");
		return this.store.write(() => {
			const threadId = this.store.threadForScope(scope);
			const existing = this.store.find(scope, taskId);
			if (existing) return { task: this.store.task(existing), created: false };
			const wakeRequested = wake && !this.store.hasPendingWork(scope);
			const now = this.now();
			this.store.insert(scope, taskId, now);
			this.saveRevision(taskId, 1, input, author, now, files);
			return {
				task: this.get(scope, taskId),
				created: true,
				...(wakeRequested ? { wakeThreadId: threadId } : {}),
			};
		});
	}

	/** Changes the instruction and requeues it atomically, invalidating any old claim. */
	edit(
		command: RevisionEdit,
		input: TaskInput,
		author: Actor,
		{ preserveTitle = false, preserveBody = false, appendBody = "" } = {},
	): Task {
		const files = decodeFiles(input);
		return this.store.write(() => {
			const row = this.requireTask(command.scope, command.taskId);
			// Worker status changes do not conflict with edits to the same instruction.
			if (row.revision !== command.expectedRevision) throw new TaskError("conflict");
			if (row.state === "cancelled") throw new TaskError("invalid_state");
			const current = this.store.revision(row.id, row);
			if (input.keep.some((id) => !current.attachments.some((file) => file.id === id)))
				throw new TaskError("invalid_attachment");
			const title = preserveTitle ? row.title : input.title;
			const body = appendBody
				? appendContextText(row.body, appendBody)
				: preserveBody
					? row.body
					: input.body;
			if (!taskInput.shape.body.safeParse(body).success) throw new TaskError("invalid_context");
			const unchanged =
				title === row.title &&
				body === row.body &&
				input.mode === row.mode &&
				files.length === 0 &&
				input.keep.length === current.attachments.length &&
				input.keep.every((id, index) => id === current.attachments[index]?.id);
			if (unchanged) return this.store.task(row);
			const now = this.now();
			this.saveRevision(row.id, row.revision + 1, { ...input, title, body }, author, now, files);
			if (author === "user") this.store.recordEditNotification(row.id, row.revision + 1);
			this.store.update(command.scope, row.id, row, inactive("queued"), now, row.revision + 1);
			if (title === row.title && body === row.body) {
				const formatted = this.store.readReformulation(row.id, row.revision);
				if (formatted) this.store.saveReformulation(command.scope, row.id, row.revision, formatted);
			}
			return this.get(command.scope, row.id);
		});
	}

	/** Soft-cancels the task and invalidates its claim while preserving history. */
	cancel(command: VersionedTask): Task {
		return this.mutate(command, (row) => {
			if (row.state !== "cancelled")
				this.store.update(command.scope, row.id, row, inactive("cancelled"), this.now());
		});
	}

	/** Requeues a task requested by the user, invalidating a potentially abandoned claim. */
	requeue(command: VersionedTask): Task {
		return this.mutate(command, (row) => {
			if (row.state === "queued" || row.state === "blocked") throw new TaskError("invalid_state");
			this.store.update(command.scope, row.id, row, inactive("queued"), this.now());
		});
	}

	/** Records the user's approval and releases the blocked task in the same transaction. */
	unblock(command: VersionedTask, commentId: string, approval: string): { task: Task; wakeThreadId: string } {
		const body = commentBody.safeParse(approval);
		if (!body.success) throw new TaskError("invalid_state");
		const task = this.mutate(command, (row) => {
			if (row.state !== "blocked") throw new TaskError("invalid_state");
			const now = this.now();
			this.store.update(command.scope, row.id, row, inactive("queued"), now);
			const { created } = this.store.addComment(
				row.id,
				commentId,
				"user",
				"comment",
				body.data,
				now,
				[],
				true,
			);
			if (!created) throw new TaskError("conflict");
		});
		return { task, wakeThreadId: this.store.threadForScope(command.scope) };
	}

	/** Takes one current queued revision for an agent or the parent chat. */
	claim(command: Claim): { task: Task; claimId: string } {
		const claimId = randomUUID();
		const task = this.mutate(command, (row) => {
			if (row.state !== "queued" || (row.mode === "thread" && command.assignee !== "thread"))
				throw new TaskError("invalid_state");
			this.store.update(
				command.scope,
				row.id,
				row,
				{ state: "running", claim: claimId, assignee: command.assignee, receipt: null },
				this.now(),
			);
		});
		return { task, claimId };
	}

	/** Records verified completion, a blocker, or release of precisely the claimed revision. */
	settle(command: Settlement): Task {
		return this.store.write(() => {
			const row = this.requireTask(command.scope, command.taskId);
			if (row.state !== "running" || row.claim_id !== command.claimId) throw new TaskError("conflict");
			const proof = verification.safeParse(command.verification);
			if (command.state === "done" && !proof.success) throw new TaskError("verification_required");
			if (command.state === "blocked" && !command.receipt?.trim()) throw new TaskError("invalid_state");
			const completionReceipt =
				command.state === "done" && proof.success ? JSON.stringify(proof.data) : (command.receipt ?? null);
			const status: TaskStatus =
				command.state === "queued"
					? inactive("queued")
					: {
							state: command.state,
							claim: null,
							assignee: row.assignee,
							receipt: completionReceipt,
						};
			this.store.update(command.scope, row.id, row, status, this.now());
			return this.get(command.scope, row.id);
		});
	}

	/** Returns a scoped task snapshot. */
	get(scope: string, taskId: string): Task {
		return this.store.task(this.requireTask(scope, taskId));
	}

	/** Returns past and current instruction revisions within the board. */
	history(scope: string, taskId: string, before = Number.MAX_SAFE_INTEGER): Revision[] {
		this.requireTask(scope, taskId);
		return this.store.history(taskId, before);
	}

	/** Returns a file that belongs to the scoped task, including historical attachments. */
	file(scope: string, taskId: string, attachmentId: string): StoredFile {
		this.requireTask(scope, taskId);
		const file = this.store.file(taskId, attachmentId);
		if (!file) throw new TaskError("not_found");
		return file;
	}

	private saveRevision(
		taskId: string,
		revision: number,
		input: TaskInput,
		author: Actor,
		now: number,
		files: StoredFile[],
	): void {
		this.store.insertRevision(
			taskId,
			{ revision, title: input.title, body: input.body, mode: input.mode, author, createdAt: now },
			files,
			[...input.keep, ...files.map((file) => file.id)],
		);
	}

	private requireTask(scope: string, taskId: string): NonNullable<ReturnType<TaskRepository["find"]>> {
		const row = this.store.find(scope, taskId);
		if (!row) throw new TaskError("not_found");
		return row;
	}

	private mutate(
		command: VersionedTask,
		apply: (row: NonNullable<ReturnType<TaskRepository["find"]>>) => void,
	): Task {
		return this.store.write(() => {
			const row = this.requireTask(command.scope, command.taskId);
			if (row.serial !== command.expectedSerial) throw new TaskError("conflict");
			apply(row);
			return this.get(command.scope, command.taskId);
		});
	}
}
