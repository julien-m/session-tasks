/** Validated inputs shared by the task service and its MCP adapter. */
import { z } from "zod";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 8;
export const MAX_PAGE = 50;
export const MAX_TASK_BODY_BYTES = 32768;

/** Adds text without rewriting indentation, line breaks or code. */
export function appendContextText(before: string, appended: string): string {
	return appended ? (before ? `${before}\n\n${appended}` : appended) : before;
}

export const byteLength = (value: string): number => new TextEncoder().encode(value).length;
const textBytes = (maximum: number) =>
	z
		.string()
		.max(maximum)
		.refine((value) => byteLength(value) <= maximum);
export const threadId = textBytes(256).refine((value) => value.trim().length > 0);
export const id = z.uuidv4();
export const resumeCode = z
	.string()
	.length(32)
	.regex(/^[0-9a-f]{32}$/u);
export const resumeCodePrefix = "Session Tasks resume code: ";
export const serial = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const mode = z.enum(["auto", "thread"]);
export const state = z.enum(["queued", "running", "blocked", "done", "cancelled"]);
export const actor = z.enum(["agent", "user"]);
export const boardFilter = z.enum(["all", "remaining", "blocked", "done", "cancelled"]);
export type BoardFilter = z.infer<typeof boardFilter>;
export const panelViewFilters = ["remaining", "blocked", "done", "cancelled"] as const;
export const boardPanelView = z
	.object({
		tab: z.number().int().min(0).max(3),
		filters: z.array(z.enum(panelViewFilters)).max(3),
		instructionHistory: z.boolean(),
		cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		scrollTop: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	})
	.strict()
	.refine(
		({ filters }) =>
			new Set(filters).size === filters.length && (!filters.includes("cancelled") || filters.length === 1),
	);
export type BoardPanelView = z.output<typeof boardPanelView>;
export const MAX_BOARD_NOTE_BYTES = 32768;
export const boardNote = z
	.object({
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		body: textBytes(MAX_BOARD_NOTE_BYTES).refine((value) => !/\p{Surrogate}/u.test(value)),
	})
	.strict();
export type BoardNote = z.infer<typeof boardNote>;
export const boardNotePanel = boardNote.extend({ formatting: z.boolean().optional() });
export const MAX_BOARD_INSTRUCTIONS_BYTES = 4096;
export const boardInstructionsBody = textBytes(MAX_BOARD_INSTRUCTIONS_BYTES);
const instructionDocument = z.object({
	revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	body: boardInstructionsBody,
});
export const instructionChanges = z
	.object({
		chat: instructionDocument.optional(),
		permanent: instructionDocument.optional(),
	})
	.strict();
export type InstructionChanges = z.infer<typeof instructionChanges>;
export interface BoardInstructions {
	chat: z.infer<typeof instructionDocument>;
	permanent: z.infer<typeof instructionDocument>;
}
export const instructionMoment = z.enum(["start", "turn", "finish"]);
export type InstructionMoment = z.infer<typeof instructionMoment>;
export const instructionMoments = z
	.array(instructionMoment)
	.min(1)
	.max(3)
	.refine((values) => new Set(values).size === values.length);
export const instructionMomentFlags = { start: 1, turn: 2, finish: 4 } satisfies Record<
	InstructionMoment,
	number
>;
export const instructionEntryId = z.union([id, z.enum(["chat", "permanent"])]);
export const instructionProjectId = z.uuid();
export const MAX_INSTRUCTION_TARGETS = 100;
export const instructionTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("chat") }).strict(),
	z.object({ kind: z.literal("global") }).strict(),
	z.object({ kind: z.literal("project"), projectId: instructionProjectId }).strict(),
	z
		.object({
			kind: z.literal("projects_except"),
			projectIds: z
				.array(instructionProjectId)
				.max(MAX_INSTRUCTION_TARGETS)
				.refine((ids) => new Set(ids).size === ids.length),
		})
		.strict(),
]);
export type InstructionTarget = z.infer<typeof instructionTarget>;
export function instructionTargetKey(target: InstructionTarget): string {
	return target.kind === "projects_except"
		? JSON.stringify([target.kind, [...target.projectIds].sort()])
		: JSON.stringify(target);
}
export type InstructionBinding = InstructionTarget | { kind: "other_chat" };
export interface InstructionProject {
	id: string;
	name: string;
	chatCount?: number;
}
const distinctInstructionTargets = (values: InstructionTarget[]): boolean =>
	new Set(values.map((target) => (target.kind === "project" ? target.projectId : target.kind))).size ===
	values.length;
export const instructionTargets = z
	.array(instructionTarget)
	.max(MAX_INSTRUCTION_TARGETS)
	.refine(distinctInstructionTargets)
	.refine((values) => values.length === 1 || values.every((target) => target.kind !== "projects_except"));

export const instructionEntryWrite = z
	.object({
		entryId: instructionEntryId,
		expectedRevision: instructionDocument.shape.revision,
		body: boardInstructionsBody.refine((body) => Boolean(body.trim())),
		permanent: z.boolean(),
		projectId: instructionProjectId.optional(),
		targets: instructionTargets.optional(),
		moments: instructionMoments.optional(),
		replaceTargetsFrom: z.array(instructionTarget).refine(distinctInstructionTargets).optional(),
	})
	.refine(({ permanent, projectId }) => !permanent || !projectId)
	.refine(
		({ replaceTargetsFrom, targets, expectedRevision }) =>
			replaceTargetsFrom === undefined || (expectedRevision > 0 && Boolean(targets?.length)),
	);
export type InstructionEntryWrite = z.infer<typeof instructionEntryWrite>;
export interface InstructionEntry {
	id: z.infer<typeof instructionEntryId>;
	revision: number;
	body: string;
	permanent: boolean;
	projectId?: string;
	bindings?: InstructionBinding[];
	createdAt?: number;
	moments?: InstructionMoment[];
}
export const MAX_COMMENT_BYTES = 8192;
export const commentBody = textBytes(MAX_COMMENT_BYTES).refine((value) => value.trim().length > 0);
export const manualCheck = textBytes(1200).refine((value) => value.trim().length > 0);
export const receipt = textBytes(8192).refine((value) => value.trim().length > 0);
const verificationText = textBytes(1500).refine((value) => value.trim().length > 0);
export const verification = z
	.object({
		work: verificationText,
		check: verificationText,
		result: verificationText,
		evidence: verificationText,
	})
	.strict()
	.refine((value) => byteLength(JSON.stringify(value)) <= 8192);
export type Verification = z.infer<typeof verification>;
export const assignee = textBytes(240).refine((value) => value.trim().length > 0);

export const upload = z
	.object({
		name: textBytes(255).refine(
			(name) =>
				name.trim().length > 0 &&
				!/[\\/]/u.test(name) &&
				Array.from(name).every((character) => character.charCodeAt(0) >= 32),
		),
		mime: z
			.string()
			.max(127)
			.regex(/^[a-z0-9][a-z0-9+._-]*\/[a-z0-9][a-z0-9+._-]*$/u),
		data: z.base64().max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
	})
	.strict();

export const taskInput = z
	.object({
		title: z
			.string()
			.max(240)
			.transform((value) => value.trim())
			.pipe(textBytes(240).refine(Boolean)),
		body: textBytes(MAX_TASK_BODY_BYTES).default(""),
		mode: mode.default("auto"),
		keep: z.array(id).max(MAX_FILES).default([]),
		files: z.array(upload).max(MAX_FILES).default([]),
	})
	.strict()
	.refine(
		(value) =>
			value.keep.length + value.files.length <= MAX_FILES && new Set(value.keep).size === value.keep.length,
	);

export const commentContent = z
	.object({
		body: textBytes(MAX_COMMENT_BYTES),
		files: taskInput.shape.files,
	})
	.strict()
	.refine(({ body, files }) => Boolean(body.trim()) || files.length > 0);

export type TaskInput = z.output<typeof taskInput>;
export type Actor = z.output<typeof actor>;
export type State = z.output<typeof state>;
export type Mode = z.output<typeof mode>;

export interface Attachment {
	id: string;
	name: string;
	mime: string;
	bytes: number;
}

export interface Revision {
	revision: number;
	title: string;
	body: string;
	mode: Mode;
	author: Actor;
	createdAt: number;
	attachments: Attachment[];
}

export const reformulation = z
	.object({
		title: taskInput.shape.title.refine((value) => !/[\r\n]/u.test(value)),
		body: textBytes(MAX_TASK_BODY_BYTES).refine((value) => value.trim().length > 0),
	})
	.strict();
export type Reformulation = z.infer<typeof reformulation>;
export interface PresentedInstruction extends InstructionEntry {
	reformulation?: Reformulation;
	reformulationPending?: boolean;
	reformulationFailed?: boolean;
}

export interface Task extends Revision {
	id: string;
	ordinal: number;
	serial: number;
	state: State;
	assignee: string | null;
	receipt: string | null;
	verification?: Verification;
	manualValidation?: string;
	updatedAt: number;
	firstCreatedAt?: number;
	completedAt?: number;
	completedAtEstimated?: boolean;
}

export interface TaskComment {
	id: string;
	ordinal: number;
	author: Actor;
	kind: "comment" | "blocker";
	body: string;
	createdAt: number;
	attachments?: Attachment[];
}

export type TaskSummary = Pick<
	Task,
	"id" | "ordinal" | "serial" | "revision" | "title" | "mode" | "state" | "assignee"
> & {
	attachmentCount: number;
	blockedReason: string | null;
	firstCreatedAt?: number;
	completedAt?: number;
	completedAtEstimated?: boolean;
};

export class TaskError extends Error {
	constructor(
		readonly code:
			| "invalid_context"
			| "not_found"
			| "conflict"
			| "invalid_state"
			| "invalid_attachment"
			| "invalid_scope"
			| "verification_required",
	) {
		super(code);
	}
}
