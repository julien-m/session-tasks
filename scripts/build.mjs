/** Bundles the MCP endpoint, hook and sandboxed browser resource. */
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const [panel] = await Promise.all([
	build({
		entryPoints: ["src/panel.ts"],
		write: false,
		bundle: true,
		format: "esm",
		target: "chrome135",
		minify: true,
	}),
	build({
		entryPoints: { "http-server": "src/http-server.ts" },
		outdir: "dist",
		outExtension: { ".js": ".mjs" },
		platform: "node",
		format: "esm",
		bundle: true,
		target: "node22",
		packages: "external",
	}),
	build({
		entryPoints: ["src/hook.ts"],
		outfile: "dist/hook.mjs",
		platform: "node",
		format: "esm",
		bundle: true,
		target: "node22",
		legalComments: "inline",
	}),
]);
const script = panel.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile("src/panel.css", "utf8");
await writeFile(
	"dist/tasks.html",
	`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Session Tasks</title><style>${css}</style><body><script type="module">${script}</script></body></html>`,
);
