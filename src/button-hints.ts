/** One visual hint for the panel's native buttons and disclosure controls. */
const controls = "button, summary";
const hoverDelay = 400;
const leaveDelay = 150;
const gutter = 8;
const gap = 6;

function eventControl(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>(controls) : null;
}

function controlLabel(control: HTMLElement): string {
	return (
		control.dataset.hint?.trim() ||
		control.getAttribute("aria-label")?.trim() ||
		control.textContent.replace(/\s+/gu, " ").trim()
	);
}

/** Installs delegated hints so controls added by a later render are covered automatically. */
export function installButtonHints(unavailable: (label: string) => string): void {
	const hint = document.createElement("div");
	hint.className = "button-hint";
	hint.setAttribute("aria-hidden", "true");
	hint.hidden = true;
	const topLayer = typeof hint.showPopover === "function";
	if (topLayer) hint.popover = "manual";
	let hovered: HTMLElement | null = null;
	let focused: HTMLElement | null = null;
	let dismissed: HTMLElement | null = null;
	let active: HTMLElement | null = null;
	let showTimer: number | undefined;
	let leaveTimer: number | undefined;

	function hide(): void {
		if (topLayer && hint.matches(":popover-open")) hint.hidePopover();
		hint.hidden = true;
		active = null;
		observer.disconnect();
	}

	function place(): void {
		if (!active?.isConnected || !active.checkVisibility() || active.closest("[inert]")) {
			if (hovered === active) hovered = null;
			if (focused === active) focused = null;
			hide();
			return;
		}
		const label = controlLabel(active);
		const disabled = active.matches(":disabled");
		const message = disabled ? active.dataset.disabledHint || unavailable(label) : label;
		if (hint.textContent !== message) hint.textContent = message;
		const trigger = active.getBoundingClientRect();
		const { width, height } = hint.getBoundingClientRect();
		const viewportWidth = document.documentElement.clientWidth;
		const viewportHeight = document.documentElement.clientHeight;
		const left = trigger.x + (trigger.width - width) / 2;
		const above = trigger.top - gap - height;
		const top = above >= gutter ? above : trigger.bottom + gap;
		hint.style.left = `${Math.max(gutter, Math.min(left, viewportWidth - width - gutter))}px`;
		hint.style.top = `${Math.max(gutter, Math.min(top, viewportHeight - height - gutter))}px`;
	}

	const observer = new MutationObserver(place);

	function show(control: HTMLElement): void {
		if (!control.isConnected || !control.checkVisibility() || !controlLabel(control)) return;
		// Inside a modal, the hint must stay in its interactive subtree.
		const host = control.closest("dialog[open]") ?? document.body;
		if (hint.parentElement !== host) host.append(hint);
		active = control;
		hint.hidden = false;
		if (topLayer && !hint.matches(":popover-open")) hint.showPopover();
		place();
		if (active)
			observer.observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
				attributeFilter: [
					"hidden",
					"open",
					"inert",
					"disabled",
					"data-hint",
					"data-disabled-hint",
					"aria-label",
				],
			});
	}

	function update(preferFocus = false): void {
		window.clearTimeout(showTimer);
		const next = preferFocus ? (focused ?? hovered) : (hovered ?? focused);
		if (active === next && active !== null) return;
		hide();
		if (!next || next === dismissed) return;
		dismissed = null;
		if (next === focused && (preferFocus || !hovered)) show(next);
		else showTimer = window.setTimeout(() => show(next), hoverDelay);
	}

	function dismiss(): void {
		dismissed = active ?? hovered ?? focused;
		window.clearTimeout(showTimer);
		window.clearTimeout(leaveTimer);
		hide();
	}

	function trackPointer(event?: PointerEvent): void {
		// A visible hint stays readable under the pointer without intercepting other buttons.
		if (active && event) {
			const bounds = hint.getBoundingClientRect();
			const trigger = active.getBoundingClientRect();
			const inHint =
				event.clientX >= bounds.left &&
				event.clientX <= bounds.right &&
				event.clientY >= bounds.top &&
				event.clientY <= bounds.bottom;
			const crossingGap =
				event.clientX >= Math.max(bounds.left, trigger.left) &&
				event.clientX <= Math.min(bounds.right, trigger.right) &&
				event.clientY >= Math.min(bounds.bottom, trigger.bottom) &&
				event.clientY <= Math.max(bounds.top, trigger.top);
			if (inHint || crossingGap) {
				window.clearTimeout(leaveTimer);
				hovered = active;
				return;
			}
		}
		const control = eventControl(event?.target ?? null);
		if (control === hovered) return;
		if (dismissed === hovered && focused !== hovered) dismissed = null;
		hovered = control;
		window.clearTimeout(leaveTimer);
		window.clearTimeout(showTimer);
		if (control) update();
		else leaveTimer = window.setTimeout(update, leaveDelay);
	}

	for (const eventName of ["pointerover", "pointermove"] as const) {
		document.addEventListener(eventName, (event) => {
			if (event.pointerType !== "touch") trackPointer(event);
		});
	}
	document.documentElement.addEventListener("pointerleave", () => trackPointer());
	document.addEventListener("focusin", (event) => {
		const control = eventControl(event.target);
		focused = control?.matches(":focus-visible") ? control : null;
		if (focused || !hovered) update(true);
	});
	document.addEventListener("focusout", () => {
		if (dismissed === focused && hovered !== focused) dismissed = null;
		focused = null;
		if (!hovered) update();
	});
	document.addEventListener("pointerdown", dismiss, { capture: true });
	document.addEventListener("dragstart", dismiss, { capture: true });
	document.addEventListener(
		"scroll",
		() => {
			if (!active) return;
			const bounds = active.getBoundingClientRect();
			const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
			if (!active.contains(hit)) dismiss();
			else place();
		},
		{ capture: true, passive: true },
	);
	window.addEventListener("blur", () => {
		dismiss();
		hovered = focused = dismissed = null;
	});
	window.addEventListener("resize", () => {
		if (active) place();
	});
	window.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Escape" || !active) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			dismiss();
		},
		{ capture: true },
	);
}
