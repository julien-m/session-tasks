import { z } from "zod";
import { byteLength, instructionProjectId } from "./contract.ts";

export const quickActionPrompt = "Run the Session Tasks quick action.";
export const quickActionTitlePrefix = "Run the Session Tasks quick action: ";
export const quickActionCodePrefix = "Session Tasks action code: ";
export const quickActionColors = [
	"#3A8F68",
	"#247D71",
	"#589747",
	"#3577C5",
	"#526FC3",
	"#638DD2",
	"#8059BE",
	"#9A5DAB",
	"#AC4E80",
	"#A95355",
	"#C16B49",
	"#BC8E39",
	"#AA9B43",
	"#5D797F",
	"#847369",
] as const;
export const quickActionBody = z.string().refine((text) => text.trim() !== "" && byteLength(text) <= 8192);
export const quickActionText = z.object({
	title: z
		.string()
		.trim()
		.min(1)
		.max(48)
		.refine((text) => !/[\r\n]/u.test(text)),
	body: quickActionBody,
});
export const quickActionAudience = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("global") }),
	z.object({ kind: z.literal("chat") }),
	z.object({
		kind: z.literal("projects"),
		ids: z
			.array(instructionProjectId)
			.min(1)
			.max(100)
			.refine((ids) => new Set(ids).size === ids.length),
	}),
]);
export const quickActionInput = quickActionText.extend({
	audience: quickActionAudience,
	color: z
		.string()
		.regex(/^#[\da-f]{6}$/iu)
		.transform((value) => value.toUpperCase())
		.nullable(),
});
export type QuickActionInput = z.output<typeof quickActionInput>;
export type QuickActionSuggestion = Pick<QuickActionInput, "title" | "body" | "color">;
export type QuickAction = QuickActionInput & {
	id: string;
	revision: number;
	position: number;
	available: boolean;
};
