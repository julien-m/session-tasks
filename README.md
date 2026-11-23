# Session Tasks

Local Codex Desktop plugin. Node.js 22.18+, TypeScript, SQLite, native MCP App.

The chat and panel share a persistent task queue. The panel displays the current instruction, with previous instructions and attachments in a separate history. A user edit invalidates the claim on the previous revision. Cancellation keeps the revision history and removes the item from the active queue.

Completion requires the agent to report the work performed, an executed check, the observed result and evidence. If a check fails or cannot run, the agent records a blocker. The task details display those fields. Click the checkmark or **Mark as to do** to queue the same task for another attempt.

## Host integration

The plugin uses the supported MCP App thread tab and lifecycle hooks. The desired inline location between Outputs and Sources is a host integration requirement. The installed host composes that rail from built-in sections and its public MCP entrypoints support a thread tab without a rail placement field.

## Install from the source checkout

1. Run `npm ci` and `npm run package` in the plugin checkout.
2. Register the checkout and `node <checkout>/dist/http-server.mjs 46173` with Localhost Supervisor. Use the loopback port `46173`, autostart `agent-start` and restart `on-failure` for the durable MCP endpoint.
3. Use `codex plugin marketplace add ./artifacts/marketplace` and `codex plugin add session-tasks@session-tasks-local`. Review the bundled hook definitions in the host and approve the ones you want to run. Open a fresh chat so it loads the plugin.
4. Submit a work request. The `UserPromptSubmit` hook supplies the exact task board; Codex registers actionable items and requests the native Session Tasks tab. The first open and visibility depend on the host. An unbound tab asks to be opened by the agent in the chat.

During a turn, add entries directly in the panel. Codex rereads the queue between tasks and at the end of the turn. When the first new task is added to a drained board after the local chat's last turn has ended, the panel asks Codex to resume that chat with a short prompt. **Resume** is available when the host supports messages and the automatic wake could not be confirmed. **Release claim** lets you return an abandoned item to the queue after checking the previous worker has stopped. The old claim becomes invalid immediately. **Cancel task** is reversible from the Cancelled list.

The service listens on IPv4 loopback only. It checks Host and Origin and returns task data only for the current board capability. Task files stay in the local SQLite database under `~/Library/Application Support/Session Tasks/` until they are fetched for the intended work. An individual attachment can be at most 4 MiB, with at most 8 files per task revision and 8 MiB of new attachments per save. Keep the installation directory available to the supervisor.

Run `npm run check` for formatting, type and SQLite tests and `npm run verify-mcp` against the running service for the real MCP and hook flow.

Run `npm run verify-live-add` for the live continuation check. It starts a disposable Codex turn, waits for a claimed task, adds a second task through the panel's MCP tool and verifies that both end in the same turn. It uses the installed plugin and trusted hooks. Set `SESSION_TASKS_CODEX_CLI` to the matching Desktop CLI if multiple Codex versions are installed.

The experimental native summary companion is separate from the MCP plugin package. Its version-guarded script stages a copy of Codex, inserts the read-only task list immediately after Sources, verifies the archive and signs the staged copy. Installation requires a compatible signing team for its linked libraries and a clean shutdown. The exchange is atomic and leaves the prior bundle in the staging directory for restoration.

In the panel, drop a file, image or plain text on a task row or its details to attach it to that task. Dropping or pasting on the panel background creates a queued task with a generated title and opens its editor. The task is already saved, so the optional description can be skipped. In the editor, plain text typed or pasted into a field keeps the field's normal behavior. Images and files can be dropped or pasted anywhere in the form. Use **Browse** if a file cannot be dragged.

When you add a task manually, the editor focuses the details. The first nonempty line suggests a title that you can edit before saving.

Use the small **+** to open the full editor, or type a title in the list and press **Enter** to add it immediately. Click a task title to see its instructions, verification evidence, attachments and expandable revision history. Click the pencil to edit it directly. Codex controls the width of the native tab; the panel layout adapts when you resize it.
