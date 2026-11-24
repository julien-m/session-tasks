/** Starts the loopback MCP endpoint owned by Localhost Supervisor. */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import manifest from "../plugin.json" with { type: "json" };
import { localCodexProjects } from "./codex-projects.ts";
import { MAX_UPLOAD_BYTES } from "./contract.ts";
import { createTaskMcp } from "./mcp-tools.ts";
import { openDatabase, TaskRepository } from "./repository.ts";
import { DEFAULT_PORT, databasePath, HOST } from "./runtime.ts";
import { TaskService } from "./task-service.ts";

const port = z.coerce
	.number()
	.int()
	.min(1024)
	.max(65535)
	.parse(process.argv[2] ?? DEFAULT_PORT);
const authority = `${HOST}:${port}`;
const database = openDatabase(databasePath());
const service = new TaskService(new TaskRepository(database), Date.now, localCodexProjects());
const html = readFileSync(new URL("./tasks.html", import.meta.url), "utf8");
const handler = createMcpHandler(() => createTaskMcp(service, html, manifest.version), {
	maxRequestBodySize: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 131072,
	maxSubscriptions: 8,
});
const serve = toNodeHandler(handler);
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (request, response) => {
	// The host check rejects DNS rebinding; browser origins outside the local endpoint cannot invoke it.
	if (
		request.headers.host !== authority ||
		(request.headers.origin && request.headers.origin !== `http://${authority}`)
	) {
		response.writeHead(403).end();
		return;
	}
	if (request.url === "/health" && request.method === "GET") {
		response
			.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
			.end(JSON.stringify({ ok: true, version: manifest.version }));
		return;
	}
	if (request.url !== "/mcp") {
		response.writeHead(404).end();
		return;
	}
	void Promise.resolve(serve(request as Parameters<typeof serve>[0], response)).catch(() => {
		if (!response.headersSent) response.writeHead(500);
		response.end();
		process.stderr.write('{"event":"http_request_failed","level":"error"}\n');
	});
});
server.listen(port, HOST);

const stop = () => {
	void handler.close().finally(() => {
		server.closeAllConnections();
		server.close(() => database.close());
	});
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
