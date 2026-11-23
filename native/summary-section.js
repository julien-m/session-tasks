// Host-specific renderer. The patch inserts this module beside the existing Sources section.
// biome-ignore lint/correctness/noUnusedVariables: The version-checked bundle calls this function.
function SessionTasksNative({ threadId }) {
	// These are the React, JSX and section exports of the checked host module.
	const { jsx, jsxs } = a;
	const { useState, useEffect, useRef } = h;
	const french = /^fr(?:-|$)/i.test(navigator.language);
	const labels = french
		? {
				title: "Tâches",
				queued: "À faire",
				running: "En cours",
				blocked: "Bloquée",
				done: "Terminée",
				loading: "Chargement…",
				empty: "Aucune tâche dans ce chat.",
				unavailable: "Liste indisponible",
				more: "Ouvre Session Tasks pour voir le reste.",
			}
		: {
				title: "Tasks",
				queued: "To do",
				running: "In progress",
				blocked: "Blocked",
				done: "Done",
				loading: "Loading…",
				empty: "No tasks in this chat.",
				unavailable: "Task list unavailable",
				more: "Open Session Tasks to see the rest.",
			};
	const [snapshot, setSnapshot] = useState(null);
	const list = useRef(null);

	useEffect(() => {
		let active = true;
		let visible = true;
		let pending = false;
		const refresh = async () => {
			if (!visible || document.hidden || pending) return;
			pending = true;
			try {
				const data = await window.electronBridge.readSessionTasks(threadId);
				if (active)
					setSnapshot((previous) =>
						data?.status === "ready" ? data : { ...previous, status: "unavailable" },
					);
			} catch {
				if (active) setSnapshot((previous) => ({ ...previous, status: "unavailable" }));
			} finally {
				pending = false;
			}
		};
		const observer = new IntersectionObserver(([item]) => {
			visible = item.isIntersecting;
			if (visible) void refresh();
		});
		if (list.current) observer.observe(list.current);
		document.addEventListener("visibilitychange", refresh);
		void refresh();
		const timer = window.setInterval(refresh, 3000);
		return () => {
			active = false;
			observer.disconnect();
			document.removeEventListener("visibilitychange", refresh);
			window.clearInterval(timer);
		};
	}, [threadId]);

	const tasks = snapshot?.tasks ?? [];
	const status =
		snapshot?.status === "unavailable" ? labels.unavailable : snapshot ? labels.empty : labels.loading;
	const marker = { queued: "○", running: "◉", blocked: "⊘", done: "✓" };
	const stateColor = {
		queued: "currentColor",
		running: "light-dark(#315f99, #90b7fb)",
		blocked: "light-dark(#825013, #e6a765)",
		done: "light-dark(#276546, #8ac9a4)",
	};
	const children = tasks.map((task) =>
		jsxs(
			"li",
			{
				style: {
					display: "grid",
					gridTemplateColumns: "16px minmax(0, 1fr)",
					columnGap: 8,
					alignItems: "start",
				},
				children: [
					jsx("span", {
						"aria-hidden": true,
						style: {
							color: stateColor[task.state],
							inlineSize: 14,
							blockSize: 14,
							display: "grid",
							placeItems: "center",
							border: task.state === "done" ? "1px solid currentColor" : undefined,
							borderRadius: "50%",
							fontSize: task.state === "done" ? 10 : 14,
							lineHeight: 1,
							marginTop: 2,
						},
						children: marker[task.state],
					}),
					jsxs("span", {
						style: { overflowWrap: "anywhere", opacity: task.state === "done" ? 0.75 : 1 },
						children: [
							jsx("span", { className: "sr-only", children: `${labels[task.state]}. ` }),
							task.title,
							task.state === "running"
								? jsx("span", {
										"aria-hidden": true,
										style: { display: "block", color: stateColor.running, fontSize: 11 },
										children: labels.running,
									})
								: null,
						],
					}),
				],
			},
			task.id,
		),
	);
	return jsx(B.x.Section, {
		sectionKey: "session-tasks-native",
		title: labels.title,
		titleSuffix: snapshot?.total > 0 ? jsx(B.x.SectionCount, { count: snapshot.total }) : null,
		children: jsxs("div", {
			ref: list,
			className: "text-sm text-text-secondary",
			style: { display: "grid", gap: 8 },
			children: [
				tasks.length
					? jsx("ul", {
							style: { display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" },
							children,
						})
					: null,
				!tasks.length || snapshot?.status === "unavailable" ? jsx("p", { children: status }) : null,
				snapshot?.total > tasks.length ? jsx("p", { children: labels.more }) : null,
			],
		}),
	});
}
