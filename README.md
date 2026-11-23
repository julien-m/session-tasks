# Session Tasks

<p align="center">
  <img src="assets/session-tasks-preview.png" width="680" alt="Session Tasks with a compact task list and a detail pane using sample data">
</p>

Local Codex Desktop plugin. Node.js 22.18+, TypeScript, SQLite, native MCP App.

The chat and panel share a persistent task queue. The panel displays the current instruction, with previous instructions and attachments in a separate history. A user edit invalidates the claim on the previous revision. Cancellation keeps the revision history and removes the item from the active queue.

Completion requires the agent to report the work performed, an executed check, the observed result and evidence. If a check fails or cannot run, the agent records a blocker. The task details display those fields. Click the checkmark or **Mark as to do** to queue the same task for another attempt.

Use **Validate** and enter what you checked and observed. You can validate a queued or blocked task yourself, or add a human check to a task Codex completed while keeping its original evidence. **Unblock** returns the task to the queue. Its previous blocker stays in the task's discussion. Posting a comment saves it on the task and takes you back to the list. Use the **Remaining**, **Blocked**, and **Done** buttons independently to combine filters.

## Host integration

The plugin uses the supported MCP App thread tab and lifecycle hooks. The desired inline location between Outputs and Sources is a host integration requirement. The installed host composes that rail from built-in sections and its public MCP entrypoints support a thread tab without a rail placement field.

## Install from the source checkout

1. Run `npm ci` and `npm run package` in the plugin checkout.
2. Register the checkout and `node <checkout>/dist/http-server.mjs 46173` with Localhost Supervisor. Use the loopback port `46173`, autostart `agent-start` and restart `on-failure` for the durable MCP endpoint.
3. Use `codex plugin marketplace add ./artifacts/marketplace` and `codex plugin add session-tasks@session-tasks-local`. Review the bundled hook definitions in the host and approve the ones you want to run. Open a fresh chat so it loads the plugin.
4. Submit a work request. The `UserPromptSubmit` hook supplies the exact task board; Codex registers actionable items and requests the native Session Tasks tab. The first open and visibility depend on the host. An unbound tab asks to be opened by the agent in the chat.

During a turn, add entries directly in the panel. Codex rereads the queue between tasks and at the end of the turn. When the first new task is added to a drained board after the local chat's last turn has ended, the panel asks Codex to resume that chat with a short prompt. **Resume** is available when the host supports messages and the automatic wake could not be confirmed. **Release claim** lets you return an abandoned item to the queue after checking the previous worker has stopped. The old claim becomes invalid immediately. **Cancel task** is reversible from the Cancelled list.

Each panel resume request includes a one-time code for that chat. The generic MCP message envelope leaves the code available for the actual Session Tasks message. Codes expire after 30 seconds.

The service listens on IPv4 loopback only. It checks Host and Origin and returns task data only for the current board capability. Task files stay in the local SQLite database under `~/Library/Application Support/Session Tasks/` until they are fetched for the intended work. An individual attachment can be at most 4 MiB, with at most 8 files per task revision and 8 MiB of new attachments per save. Keep the installation directory available to the supervisor.

Run `npm run check` for formatting, type and SQLite tests and `npm run verify-mcp` against the running service for the real MCP and hook flow.

Run `npm run verify-live-add` for the live continuation check. It starts a disposable Codex turn, waits for a claimed task, adds a second task through the panel's MCP tool and verifies that both end in the same turn. It uses the installed plugin and trusted hooks. Set `SESSION_TASKS_CODEX_CLI` to the matching Desktop CLI if multiple Codex versions are installed.

The experimental native summary companion is separate from the MCP plugin package. Its version-guarded script stages a copy of Codex, inserts the read-only task list immediately after Sources, verifies the archive and signs the staged copy. Installation requires a compatible signing team for its linked libraries and a clean shutdown. The exchange is atomic and leaves the prior bundle in the staging directory for restoration.

In the panel, drop a file, image or plain text anywhere on the list to create a queued task and open its editor. Open a task's details before dropping a file to attach it there. Pasting on a focused row attaches to that task. Pasting on the panel background creates a task. Text pasted into an input keeps its normal behavior. The list scrolls independently of the add and filter controls.

When you save a task in the full editor without a title, the task is created with the first non-empty line of the details or the first attachment's filename, and the editor closes. Session Tasks shows **Generating title…** on the row while GPT-6.1 Terra, in Low reasoning at standard speed, uses up to 1,600 characters of details or filenames to generate a short title in the background. If generation is unavailable, the provisional title remains. A title you enter yourself is used directly.

Use the small **+** to open the full editor, or type a title in the list and press **Enter** to add it immediately. Click a task title to see its instructions, verification evidence, attachments and expandable revision history. Click the pencil to edit it directly. After successful validation, the panel returns to the list unless you have an unfinished comment. The version is shown below the filters. Codex controls the width of the native tab; the panel layout adapts when you resize it.

Press **Command+Enter** or **Ctrl+Enter** anywhere in an open task editor to save. The same shortcut submits the confirmation form when it is open with a verification observation.
