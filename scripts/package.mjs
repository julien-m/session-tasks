/** Creates a local marketplace from an explicit list of distributable files. */
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

async function nodeCommand() {
	const executable = await realpath(process.execPath);
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
		const candidate = join(directory, "node");
		if ((await realpath(candidate).catch(() => undefined)) === executable) return candidate;
	}
	return process.execPath;
}

const root = "artifacts/marketplace";
const target = join(root, "plugins/session-tasks");
// The current desktop uses the legacy loader for plugin hooks. A portable
// root manifest in this package would shadow the legacy entry point.
await rm(join(target, "plugin.json"), { force: true });
await rm(join(target, "mcp.json"), { force: true });
for (const file of [
	".codex-plugin/plugin.json",
	"assets/session-tasks.png",
	"hooks/hooks.json",
	"dist/hook.mjs",
]) {
	const destination = join(target, file);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(file, destination);
}
const { version } = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
// A changed command configuration makes Codex start a fresh MCP child on upgrade.
const server = {
	command: await nodeCommand(),
	args: [resolve("dist/stdio-server.mjs"), `--release=${version}`],
};
await writeFile(
	join(target, ".mcp.json"),
	`${JSON.stringify({ mcpServers: { "session-tasks": server } }, null, 2)}\n`,
);
const registry = join(root, ".agents/plugins/marketplace.json");
await mkdir(dirname(registry), { recursive: true });
await writeFile(
	registry,
	`${JSON.stringify({ name: "session-tasks-local", interface: { displayName: "Session Tasks" }, plugins: [{ name: "session-tasks", source: { source: "local", path: "./plugins/session-tasks" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }, null, 2)}\n`,
);
