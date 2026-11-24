/** Serves the installed Codex plugin over its private child-process connection. */
import { readFileSync } from "node:fs";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import manifest from "../plugin.json" with { type: "json" };
import { localCodexProjects } from "./codex-projects.ts";
import { MAX_UPLOAD_BYTES } from "./contract.ts";
import { createTaskMcp } from "./mcp-tools.ts";
import { QuickActions } from "./quick-actions.ts";
import { openDatabase, TaskRepository } from "./repository.ts";
import { databasePath } from "./runtime.ts";
import { TaskService } from "./task-service.ts";

const database = openDatabase(databasePath());
const tasks = new TaskRepository(database);
const projects = localCodexProjects();
const service = new TaskService(tasks, Date.now, projects);
const actions = new QuickActions(database, tasks, projects);
const html = readFileSync(new URL("./tasks.html", import.meta.url), "utf8");
serveStdio(() => createTaskMcp(service, html, manifest.version, actions, { desktopStdio: true }), {
	transport: new StdioServerTransport(process.stdin, process.stdout, {
		maxBufferSize: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 131072,
	}),
	maxSubscriptions: 8,
});
