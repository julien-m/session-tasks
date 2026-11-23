/** Creates a local marketplace from an explicit list of distributable files. */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
const portableMcp = JSON.parse(await readFile("mcp.json", "utf8"));
const server = portableMcp.mcpServers["session-tasks"];
await writeFile(
	join(target, ".mcp.json"),
	`${JSON.stringify({ mcpServers: { "session-tasks": { url: server.url } } }, null, 2)}\n`,
);
const registry = join(root, ".agents/plugins/marketplace.json");
await mkdir(dirname(registry), { recursive: true });
await writeFile(
	registry,
	`${JSON.stringify({ name: "session-tasks-local", interface: { displayName: "Session Tasks" }, plugins: [{ name: "session-tasks", source: { source: "local", path: "./plugins/session-tasks" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }, null, 2)}\n`,
);
