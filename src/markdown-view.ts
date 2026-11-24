import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true });
type Token = ReturnType<typeof markdown.parse>[number];
type OpenLink = (url: string) => void;

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

function link(token: Token, openLink: OpenLink): HTMLElement {
	const href = String(token.attrGet("href") ?? "");
	const url = /^https?:\/\//i.test(href) ? URL.parse(href) : null;
	if (!url) {
		const label = document.createElement("span");
		label.title = href;
		return label;
	}
	const anchor = document.createElement("a");
	anchor.href = url.href;
	anchor.target = "_blank";
	anchor.rel = "noopener noreferrer";
	anchor.addEventListener("click", (event) => {
		event.preventDefault();
		openLink(url.href);
	});
	return anchor;
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
				code.textContent = token.content;
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
