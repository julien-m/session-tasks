/** Shared conversion of user drops and clipboard content into task input. */
import { MAX_FILE_BYTES, MAX_FILES, MAX_UPLOAD_BYTES, taskInput } from "./contract.ts";

export interface TransferredContext {
	readonly files: readonly File[];
	readonly text: string;
}

/** Only accepts explicit file and plain-text formats. Remote image URLs stay plain text. */
export function acceptsContext(transfer: DataTransfer | null): boolean {
	return !!transfer?.types.some(
		(type) => type === "Files" || type === "text/plain" || type === "text/uri-list",
	);
}

/** Snapshot the transfer while the event still grants access to its data. */
export function captureContext(transfer: DataTransfer): TransferredContext {
	const files = Array.from(transfer.files);
	const plain = transfer.getData("text/plain");
	const uri = transfer.getData("text/uri-list");
	// File managers sometimes offer the same file as a pathname or a caption alongside its bytes.
	const fileAlias =
		files.length > 0 && (plain.startsWith("file://") || files.some((file) => file.name === plain));
	return { files, text: fileAlias ? "" : plain || (files.length ? "" : uri) };
}

export function hasContext(context: TransferredContext): boolean {
	return context.files.length > 0 || context.text.trim().length > 0;
}

/** Checks limits before allocating encoded file contents. */
export function validateFiles(files: readonly File[], kept = 0): void {
	if (
		files.length + kept > MAX_FILES ||
		files.some((file) => file.size > MAX_FILE_BYTES) ||
		files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_BYTES
	)
		throw new Error("invalid_attachment");
}

/** Encodes a user-selected file without stripping filename or content. */
async function encodeFile(file: File) {
	const reader = new FileReader();
	const data = await new Promise<string>((resolve, reject) => {
		reader.onerror = () => reject(new Error("file_read"));
		reader.onload = () => {
			if (typeof reader.result !== "string") return reject(new Error("file_read"));
			resolve(reader.result.split(",", 2)[1] ?? "");
		};
		reader.readAsDataURL(file);
	});
	return { name: file.name, mime: file.type || "application/octet-stream", data };
}

export function encodeFiles(
	files: readonly File[],
	kept = 0,
): Promise<Awaited<ReturnType<typeof encodeFile>>[]> {
	validateFiles(files, kept);
	return Promise.all(files.map(encodeFile));
}

/** Produces a descriptive, validated title for a drop that has no explicit instruction. */
export function contextTitle(context: TransferredContext, fallback: string): string {
	const source =
		context.files[0]?.name || context.text.split(/[\r\n]/u).find((line) => line.trim()) || fallback;
	const title = source.trim();
	let accepted = "";
	for (const character of title) {
		const candidate = accepted + character;
		if (!taskInput.shape.title.safeParse(candidate).success && candidate.trim().length > 0) break;
		accepted = candidate;
	}
	return accepted.trim() || fallback;
}
