/** Task commands and revision-aware work ownership. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CodexProjects } from "./codex-projects.ts";
import {
	type Actor,
	appendContextText,
	type BoardFilter,
	type BoardInstructions,
	commentBody,
	type InstructionChanges,
	type InstructionEntryWrite,
	instructionChanges,
	instructionEntryWrite,
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
function decodeFiles(input: TaskInput): StoredFile[] {
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

	/** Lists the current board without fetching any attachment bytes. */
	list(
		scope: string,
		after = 0,
		cancelled: boolean | BoardFilter | BoardFilter[] = false,
		formatted = false,
	): BoardList {
		this.store.assertScope(scope);
		const filter = typeof cancelled === "boolean" ? (cancelled ? "cancelled" : "active") : cancelled;
		return this.store.list(scope, after, filter, formatted);
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

	listInstructionEntries(scope: string, presented = false, manageProjects = false): PresentedInstruction[] {
		const projectId = presented ? undefined : this.projects?.forThread(this.store.threadForScope(scope));
		return this.store.listInstructionEntries(scope, presented, projectId, manageProjects);
	}

	saveInstructionEntry(
		scope: string,
		input: InstructionEntryWrite,
		materializeLegacy = false,
		manageProjects = false,
	): PresentedInstruction {
		const checked = instructionEntryWrite.safeParse(input);
		if (!checked.success) throw new TaskError("invalid_context");
		if (
			checked.data.projectId &&
			(!manageProjects ||
				!this.listInstructionProjects(scope).some((project) => project.id === checked.data.projectId))
		)
			throw new TaskError("invalid_context");
		return this.store.saveInstructionEntry(scope, checked.data, materializeLegacy, manageProjects);
	}

	saveInstructionReformulation(
		scope: string,
		entryId: string,
		revision: number,
		result: Reformulation,
	): void {
		const checked = reformulation.safeParse(result);
		if (checked.success) this.store.saveInstructionReformulation(scope, entryId, revision, checked.data);
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
	comment(scope: string, taskId: string, commentId: string, body: string, author: Actor): TaskComment {
		return this.store.write(() => {
			this.requireTask(scope, taskId);
			const parsed = commentBody.safeParse(body);
			if (!parsed.success) throw new TaskError("invalid_state");
			return this.store.addComment(taskId, commentId, author, "comment", parsed.data, this.now());
		});
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
			if (row.state === "queued") throw new TaskError("invalid_state");
			this.store.update(command.scope, row.id, row, inactive("queued"), this.now());
		});
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
