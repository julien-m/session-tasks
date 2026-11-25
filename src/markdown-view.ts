import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
const linkComparison = new MarkdownIt({ html: false, linkify: true });
// Parse destinations for comparison even when the display cannot open them.
linkComparison.validateLink = () => true;
type Token = ReturnType<typeof markdown.parse>[number];
type OpenLink = (url: string) => boolean;
const linkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);

const containers = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"ul",
	"ol",
	"li",
	"strong",
	"em",
	"s",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
]);

function linkUrl(token: Token): URL | undefined {
	return allowedUrl(String(token.attrGet("href") ?? ""));
}

function allowedUrl(value: string): URL | undefined {
	const url = URL.parse(value);
	if (url && linkProtocols.has(url.protocol)) return url;
}

export function keepsMarkdownLinks(original: string, formatted: string): boolean {
	const tokenLinks = (token: Token): string[] => {
		if (token.type === "link_open" || token.type === "image") {
			const destination = String(token.attrGet(token.type === "image" ? "src" : "href") ?? "");
			return [`${token.type}:${allowedUrl(destination)?.href ?? destination}`];
		}
		if (token.children) return token.children.flatMap(tokenLinks);
		if (token.type === "code_inline" || token.type === "fence" || token.type === "code_block")
			return (markdown.linkify.match(token.content) ?? []).map(
				({ url }) => `link_open:${allowedUrl(url)?.href ?? url}`,
			);
		return [];
	};
	const targets = (source: string) => [
		...linkComparison.parse(source, {}).flatMap(tokenLinks),
		...(source.match(/\bfile:\/{1,3}[^\s<>"'`()[\]]+/giu) ?? []),
	];
	const before = targets(original);
	const after = targets(formatted);
	return before.length === after.length && before.every((url, index) => after[index] === url);
}

export function keepsMarkdownCode(original: string, formatted: string): boolean {
	const code = (token: Token): string[] => {
		if (token.type === "code_inline") return [`inline:${token.content}`];
		if (token.type === "fence" || token.type === "code_block") return [`block:${token.content}`];
		return token.children?.flatMap(code) ?? [];
	};
	const before = markdown.parse(original, {}).flatMap(code);
	const after = markdown.parse(formatted, {}).flatMap(code);
	return before.length === after.length && before.every((value, index) => value === after[index]);
}

function anchorFor(url: URL, openLink: OpenLink): HTMLAnchorElement {
	const anchor = document.createElement("a");
	anchor.href = url.href;
	anchor.target = "_blank";
	anchor.rel = "noopener noreferrer";
	anchor.addEventListener("click", (event) => {
		if (openLink(url.href)) event.preventDefault();
	});
	anchor.addEventListener("auxclick", (event) => {
		if (event.button === 1 && openLink(url.href)) event.preventDefault();
	});
	return anchor;
}

function link(token: Token, openLink: OpenLink): HTMLElement {
	const url = linkUrl(token);
	if (url) return anchorFor(url, openLink);
	const label = document.createElement("span");
	label.title = String(token.attrGet("href") ?? "");
	return label;
}

export function renderLinkableText(target: HTMLElement, source: string, openLink: OpenLink): void {
	const content = document.createDocumentFragment();
	let cursor = 0;
	for (const match of markdown.linkify.match(source) ?? []) {
		const url = allowedUrl(match.url);
		if (!url) continue;
		content.append(source.slice(cursor, match.index));
		const anchor = anchorFor(url, openLink);
		anchor.textContent = source.slice(match.index, match.lastIndex);
		content.append(anchor);
		cursor = match.lastIndex;
	}
	content.append(source.slice(cursor));
	target.replaceChildren(content);
}
function appendTokens(
	root: DocumentFragment | HTMLElement,
	tokens: readonly Token[],
	openLink: OpenLink,
): void {
	const parents: HTMLElement[] = [];
	for (const token of tokens) {
		if (token.hidden) continue;
		const parent = parents.at(-1) ?? root;
		if (token.nesting === -1) {
			parents.pop();
			continue;
		}
		if (token.nesting === 1) {
			const node =
				token.tag === "a"
					? link(token, openLink)
					: document.createElement(containers.has(token.tag) ? token.tag : "span");
			const start = token.tag === "ol" ? String(token.attrGet("start") ?? "") : "";
			if (start && /^\d+$/.test(start)) node.setAttribute("start", start);
			parent.append(node);
			parents.push(node);
			continue;
		}
		switch (token.type) {
			case "inline":
				if (token.children) appendTokens(parent, token.children, openLink);
				break;
			case "text":
			case "image":
				parent.append(token.content);
				break;
			case "hardbreak":
			case "softbreak":
				parent.append(document.createElement("br"));
				break;
			case "hr":
				parent.append(document.createElement("hr"));
				break;
			case "code_inline":
			case "fence":
			case "code_block": {
				const code = document.createElement("code");
				renderLinkableText(code, token.content, openLink);
				if (token.type === "code_inline") {
					parent.append(code);
					break;
				}
				const block = document.createElement("pre");
				block.append(code);
				parent.append(block);
				break;
			}
		}
	}
}

export function renderMarkdown(target: HTMLElement, source: string, openLink: OpenLink): void {
	const content = document.createDocumentFragment();
	appendTokens(content, markdown.parse(source, {}), openLink);
	target.replaceChildren(content);
}
