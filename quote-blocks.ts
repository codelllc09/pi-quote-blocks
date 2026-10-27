/**
 * quote-blocks.ts — Codex-style quote blocks for Pi (Alt+Q)
 *
 * Terminal editors are plain text grids, so inline floating blocks are not
 * possible. This extension gets the same effect with three layers:
 *
 *   1. Block cards render in the widget area above the editor (same spot
 *      as image chips)
 *   2. The draft only holds short [Qn] markers; marker position = anchor
 *   3. On submit (input-event transform) markers expand to Markdown quotes
 *
 * Layout:
 *
 *   ❝ Q1 · 3 lines            ← widget: quote block cards
 *   │ The cache should expire after 24 hours.
 *   ❝ Q2 · 1 line
 *   │ switch to docker compose deploy
 *   ────────────────────────────────
 *   ❯ [Q1] is this right? [Q2] and this?   ← draft: short markers only
 *
 * Shortcuts: Alt+Q quote selection; Alt+Shift+Q fold/expand
 * Commands:  /quote-selection (same as Alt+Q) · /quotes [clear|fold|unfold]
 * Folding:   auto-collapse to one line beyond PI_QUOTE_FOLD_LINES (default 8)
 *
 * Design notes from debugging history (2026-10):
 *   - Block state (quotes/nextId) lives in globalThis[Symbol.for(...)] so it
 *     survives /reload and module re-instantiation. Without this, the widget
 *     and the input handler can end up in different module instances, each
 *     with its own empty state — quotes visibly stack but never expand.
 *   - pruneQuotes() must NOT prune when the draft is empty: on submit the
 *     TUI clears the editor BEFORE the input event fires, so an empty draft
 *     at that moment means "submitting", not "user deleted the markers".
 *   - The sent text is the single source of truth at input time: markers
 *     found in it expand; blocks not referenced in it are dropped.
 *
 * Selection acquisition derives from alandarev/pi-quote v0.1.2 (MIT):
 * https://github.com/alandarev/pi-quote — version gate follows upstream
 * discipline (per-version review) with an escape hatch env.
 */

import * as fs from "node:fs";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const MIN_PI_VERSION = "1.0.3";
/** Pi versions verified against the renderer/editor APIs used below.
 * Re-verify after each Pi release before adding it here. */
export const REVIEWED_PI_VERSIONS = ["1.0.3", "1.4.0"];
export const SHORTCUT = "alt+q";
const WIDGET_KEY = "quote-blocks";
const MAX_PREVIEW_LINES = 2;
const FOLD_THRESHOLD = Number(process.env.PI_QUOTE_FOLD_LINES ?? 8);
const DEBUG_LOG = process.env.PI_QUOTE_DEBUG_LOG ?? "/tmp/quote-blocks-debug.log";
/** Debug log: only written when PI_QUOTE_DEBUG=1; zero I/O otherwise. */
const DEBUG = process.env.PI_QUOTE_DEBUG === "1";

/** Random per-module-instance fingerprint, for split-instance diagnosis. */
const INSTANCE = Math.random().toString(36).slice(2, 8);
const dbg = (message: string): void => {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${INSTANCE}] ${message}\n`);
	} catch {
		/* logging must never break the feature */
	}
};
dbg("module evaluated");

// ---- Shared state (globalThis: survives /reload within one process) ----

interface QuoteStore {
	quotes: Map<number, string>;
	nextId: number;
}
const STORE = Symbol.for("pi.quoteBlocks.store");

function sharedStore(): QuoteStore {
	const g = globalThis as Record<symbol, QuoteStore | undefined>;
	if (!g[STORE]) {
		g[STORE] = { quotes: new Map(), nextId: 1 };
		dbg("store created (fresh)");
	}
	return g[STORE];
}

type SelectionRenderer = {
	mode: string;
	getActiveSelectionText(): string | undefined;
	clearTextSelection(): void;
	requestRender(): void;
	hasOverlay(): boolean;
	getFocusedComponent(): unknown;
};

/**
 * Cached renderer reference. The upstream trick (install/remove a zero-row
 * bridge widget to capture the renderer) touches the widget lifecycle on
 * every press, which makes Pi reconfigure terminal modes (keyboard protocol
 * push/pop). On WezTerm that churn can intermittently wedge the window-level
 * IME state until the next focus event. Acquiring once and caching removes
 * the churn entirely.
 */
let cachedRenderer: SelectionRenderer | undefined;

function getRenderer(ctx: ExtensionContext): SelectionRenderer {
	if (cachedRenderer?.mode === "fullscreen") {
		for (const method of ["getActiveSelectionText", "clearTextSelection", "requestRender", "hasOverlay", "getFocusedComponent"] as const) {
			if (typeof cachedRenderer[method] !== "function") {
				cachedRenderer = undefined; // stale: re-acquire below
				break;
			}
		}
		if (cachedRenderer) return cachedRenderer;
	}
	let renderer: unknown;
	// A synchronous, zero-row widget factory receives Pi's live renderer
	// reference. Install and remove immediately — once per session.
	try {
		ctx.ui.setWidget(
			`${WIDGET_KEY}:bridge`,
			(tui) => {
				renderer = tui;
				return { render: () => [], invalidate() {} };
			},
			{ placement: "belowEditor" },
		);
	} finally {
		ctx.ui.setWidget(`${WIDGET_KEY}:bridge`, undefined);
	}
	const candidate = renderer as Partial<SelectionRenderer> | undefined;
	if (candidate?.mode !== "fullscreen") {
		throw new Error("Quote blocks need Pi fullscreen mode (normal mouse drag, not Shift+drag).");
	}
	for (const method of [
		"getActiveSelectionText",
		"clearTextSelection",
		"requestRender",
		"hasOverlay",
		"getFocusedComponent",
	] as const) {
		if (typeof candidate[method] !== "function") {
			throw new Error(`Quote blocks unavailable: Pi renderer API changed (${method}).`);
		}
	}
	cachedRenderer = candidate as SelectionRenderer;
	dbg("renderer acquired and cached (one-time bridge)");
	return cachedRenderer;
}

/** Pi's built-in prompt editor (pi-tui Editor). `moveToLineEnd` is private, guarded by runtime probing. */
type CursorEditor = {
	getLines(): string[];
	getCursor(): { line: number; col: number };
	moveToLineEnd(): void;
	insertTextAtCursor(text: string): void;
	getText(): string;
	getExpandedText?(): string;
};

type ThemeLike = {
	fg(color: string, text: string): string;
};

function versionAtLeast(a: string, b: string): boolean {
	const parse = (v: string) =>
		v
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const [va, vb] = [parse(a), parse(b)];
	for (let i = 0; i < Math.max(va.length, vb.length); i++) {
		const d = (va[i] ?? 0) - (vb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return true;
}

/** Raw selection text → Markdown quote lines (the form sent to the model). */
export function formatQuote(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	if (!normalized.trim()) return "";
	return normalized
		.split("\n")
		.map((line) => (line.length ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * Replace a [Qn] marker with its quote, padded with blank lines on both
 * sides. Without them, Markdown lazy continuation swallows the annotation
 * into the blockquote and quote/reply boundaries become unreadable.
 */
export function expandMarker(text: string, marker: string, quote: string): string {
	if (!text.includes(marker)) return text;
	const parts = text.split(marker);
	return parts
		.map((part, idx) => {
			if (idx === 0) return part;
			let seg = "";
			const prev = parts[idx - 1];
			if (prev.length > 0 && !prev.endsWith("\n")) seg += "\n\n"; // leading: not at line start
			seg += quote;
			if (part.length > 0) {
				seg += "\n\n"; // trailing: keep annotations out of the quote block
				if (part.startsWith("\n")) part = part.slice(1); // avoid double blank lines
			}
			return seg + part;
		})
		.join("");
}

/** Focused component, only if it is the prompt editor with cursor APIs; else undefined. */
function getCursorEditor(renderer: SelectionRenderer, draft: string): CursorEditor | undefined {
	const candidate = renderer.getFocusedComponent() as Partial<CursorEditor> | null | undefined;
	if (!candidate) return undefined;
	for (const method of ["getLines", "getCursor", "moveToLineEnd", "insertTextAtCursor", "getText"] as const) {
		if (typeof candidate[method] !== "function") return undefined;
	}
	const editor = candidate as CursorEditor;
	const text = typeof editor.getExpandedText === "function" ? editor.getExpandedText() : editor.getText();
	return text === draft ? editor : undefined;
}

export default function (pi: ExtensionAPI): void {
	dbg("factory invoked");
	const store = sharedStore();

	// ---- Per-instance UI state ----
	let currentCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let cachedLines: string[] | undefined;
	let cachedWidth: number | undefined;
	/** Fold state: undefined = auto (fold beyond threshold); "expanded"/"folded" = manual. */
	let foldOverride: "expanded" | "folded" | undefined;

	/** Allocate a block id: restart at Q1 whenever the store is empty. */
	function allocateId(): number {
		if (store.quotes.size === 0) store.nextId = 1;
		return store.nextId++;
	}

	const markerOf = (id: number): string => `[Q${id}]`;

	function invalidateWidget(): void {
		cachedLines = undefined;
		requestRender?.();
	}

	/** Drop blocks whose markers are no longer in the draft.
	 * Never prune when the draft is empty: on submit the editor is cleared
	 * before the input event fires, so an empty draft means "submitting". */
	function pruneQuotes(): boolean {
		if (!currentCtx) return false;
		let draft = "";
		try {
			draft = currentCtx.ui.getEditorText();
		} catch {
			return false;
		}
		if (draft.trim().length === 0) return false;
		const before = store.quotes.size;
		const removed: number[] = [];
		for (const id of [...store.quotes.keys()]) {
			if (!draft.includes(markerOf(id))) {
				store.quotes.delete(id);
				removed.push(id);
			}
		}
		if (removed.length) dbg(`prune: deleted [${removed.join(",")}] (draftLen=${draft.length})`);
		return store.quotes.size !== before;
	}

	/** Widget render: zero lines when empty; one folded line beyond the threshold. */
	function renderWidget(width: number): string[] {
		if (pruneQuotes()) cachedLines = undefined;
		if (store.quotes.size === 0) {
			foldOverride = undefined;
			return [];
		}

		const theme = currentCtx?.ui.theme as ThemeLike | undefined;
		const fg = (c: string, t: string) => (theme ? theme.fg(c, t) : t);
		const totalLines = [...store.quotes.values()].reduce(
			(sum, raw) => sum + Math.min(raw.replace(/\r\n?/g, "\n").split("\n").length, MAX_PREVIEW_LINES) + 2,
			store.quotes.size, // per-block gap (one trailing gap is popped below)
		);
		const shouldFold = foldOverride === "folded" || (foldOverride !== "expanded" && totalLines > FOLD_THRESHOLD);

		if (shouldFold) {
			const summary = `❝❝❝ ${store.quotes.size} quote blocks · ${totalLines} lines · alt+shift+q expand`;
			const line = truncateToWidth(fg("accent", summary), width, fg("dim", "…"));
			cachedWidth = width;
			cachedLines = [line];
			return cachedLines;
		}

		if (cachedLines && cachedWidth === width && cachedLines.length > 1) return cachedLines;

		const lines: string[] = [];
		for (const [id, raw] of store.quotes) {
			const quoteLines = raw.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
			const header = `❝ Q${id} · ${quoteLines.length} line${quoteLines.length > 1 ? "s" : ""}`;
			lines.push(truncateToWidth(fg("accent", header), width, "…"));
			for (const line of quoteLines.slice(0, MAX_PREVIEW_LINES)) {
				lines.push(truncateToWidth(`${fg("dim", "│ ")}${line.trim()}`, width, fg("dim", "…")));
			}
			if (quoteLines.length > MAX_PREVIEW_LINES) {
				lines.push(fg("dim", `│ … +${quoteLines.length - MAX_PREVIEW_LINES} more`));
			}
			lines.push("");
		}
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

		cachedWidth = width;
		cachedLines = lines;
		return lines;
	}

	function installWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				requestRender = () => tui.requestRender();
				dbg("widget factory installed");
				return {
					render: (width: number) => renderWidget(width),
					invalidate() {
						cachedLines = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	// ---- Alt+Q: selection → quote block ----
	async function quoteSelection(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (
			!versionAtLeast(VERSION, MIN_PI_VERSION) ||
			(!REVIEWED_PI_VERSIONS.includes(VERSION) && process.env.PI_QUOTE_ALLOW_UNREVIEWED !== "1")
		) {
			ctx.ui.notify(
				`Quote blocks: Pi ${VERSION} is not reviewed (reviewed: ${REVIEWED_PI_VERSIONS.join(", ")}). ` +
					"Review it and add to REVIEWED_PI_VERSIONS, or set PI_QUOTE_ALLOW_UNREVIEWED=1 to force.",
				"warning",
			);
			return;
		}
		try {
			const renderer = getRenderer(ctx);
			if (renderer.hasOverlay()) {
				throw new Error("Close Pi dialog before quoting transcript selection.");
			}
			const selected = renderer.getActiveSelectionText();
			const raw = typeof selected === "string" ? selected.replace(/\r\n?/g, "\n").trim() : "";
			if (!raw) {
				throw new Error("Select transcript text with mouse, then press Alt+Q.");
			}

			const id = allocateId();
			store.quotes.set(id, raw);

			const draft = ctx.ui.getEditorText();
			const editor = getCursorEditor(renderer, draft);
			if (editor) {
				editor.insertTextAtCursor(markerOf(id));
				dbg(`Alt+Q: block Q${id} (${raw.split("\n").length} lines), editor cursor insert`);
			} else {
				ctx.ui.setEditorText(`${draft}${draft.endsWith("\n") || !draft ? "" : " "}${markerOf(id)} `);
				dbg(`Alt+Q: block Q${id} (${raw.split("\n").length} lines), fallback append`);
			}
			renderer.clearTextSelection();
			renderer.requestRender();
			invalidateWidget();
			ctx.ui.notify(`Quoted as block Q${id} (${raw.split("\n").length} lines)`, "info");
		} catch (error) {
			dbg(`Alt+Q error: ${error instanceof Error ? error.message : String(error)}`);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Quote selected fullscreen text as a block",
		handler: async (ctx) => quoteSelection(ctx),
	});
	pi.registerCommand("quote-selection", {
		description: "Quote active fullscreen selection as a block (Alt+Q)",
		handler: async (_args, ctx) => quoteSelection(ctx),
	});

	// ---- Fold toggle: Alt+Shift+Q ----
	function toggleFold(ctx: ExtensionContext): void {
		if (store.quotes.size === 0) {
			ctx.ui.notify("No quote blocks", "info");
			return;
		}
		foldOverride = foldOverride === "expanded" ? "folded" : "expanded";
		invalidateWidget();
		ctx.ui.notify(foldOverride === "expanded" ? "Quote blocks expanded" : "Quote blocks folded", "info");
	}

	pi.registerShortcut("alt+shift+q", {
		description: "Toggle quote blocks fold/expand",
		handler: async (ctx) => toggleFold(ctx),
	});

	// ---- /quotes management ----
	pi.registerCommand("quotes", {
		description: "Manage quote blocks (/quotes · /quotes clear · /quotes fold · /quotes unfold)",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "fold" || sub === "unfold") {
				if (!store.quotes.size) {
					ctx.ui.notify("No quote blocks", "info");
					return;
				}
				foldOverride = sub === "fold" ? "folded" : "expanded";
				invalidateWidget();
				ctx.ui.notify(foldOverride === "expanded" ? "Quote blocks expanded" : "Quote blocks folded", "info");
				return;
			}
			if (sub === "clear") {
				if (!store.quotes.size) {
					ctx.ui.notify("No quote blocks", "info");
					return;
				}
				let draft = ctx.ui.getEditorText();
				for (const id of store.quotes.keys()) {
					draft = draft.split(markerOf(id)).join("");
				}
				ctx.ui.setEditorText(draft.replace(/ {2,}/g, " ").replace(/ $/gm, ""));
				store.quotes.clear();
				store.nextId = 1;
				foldOverride = undefined;
				invalidateWidget();
				dbg("clear: all blocks removed");
				ctx.ui.notify("All quote blocks removed", "info");
				return;
			}
			if (!store.quotes.size) {
				ctx.ui.notify("No quote blocks (select text + Alt+Q)", "info");
				return;
			}
			pruneQuotes();
			const list = [...store.quotes.entries()]
				.map(([id, raw]) => {
					const first = raw.split("\n")[0].trim().slice(0, 40);
					return `Q${id} · ${raw.split("\n").length} lines · ${first}`;
				})
				.join("\n");
			ctx.ui.notify(`Quote blocks:\n${list}`, "info");
		},
	});

	// ---- Expand markers on submit ----
	pi.on("input", async (event) => {
		dbg(`input: source=${event.source} size=${store.quotes.size} textLen=${event.text.length}`);
		if (store.quotes.size === 0) {
			dbg("input: no blocks, continue");
			return { action: "continue" };
		}
		let text = event.text;
		let changed = false;
		const expanded: number[] = [];
		for (const [id, raw] of [...store.quotes.entries()]) {
			const marker = markerOf(id);
			if (text.includes(marker)) {
				const quote = formatQuote(raw);
				text = quote ? expandMarker(text, marker, quote) : text.split(marker).join("");
				store.quotes.delete(id);
				expanded.push(id);
				changed = true;
			}
		}
		dbg(`input: expanded [${expanded.join(",") || "-"}] changed=${changed}`);
		// The sent text is the single source of truth: blocks it does not
		// reference are dropped here (the editor is already empty at this
		// point, so "user deleted the marker" cannot be told apart).
		if (store.quotes.size > 0) {
			dbg(`input: dropping unmatched [${[...store.quotes.keys()].join(",")}]`);
			store.quotes.clear();
		}
		if (store.quotes.size === 0) foldOverride = undefined; // reset fold for the next batch
		invalidateWidget();
		if (!changed) return { action: "continue" };
		dbg(`input: => transform (newLen=${text.length})`);
		return { action: "transform", text };
	});

	// ---- Lifecycle ----
	pi.on("session_start", async (_event, ctx) => {
		// New sessions (/new, /resume) start with an empty editor, so stale
		// blocks are meaningless; /reload keeps the draft, so blocks whose
		// markers survive stay. Empty-draft check is allowed here (unlike
		// pruneQuotes, there is no submit race at session_start).
		try {
			const draft = ctx.mode === "tui" ? ctx.ui.getEditorText() : "";
			for (const id of [...store.quotes.keys()]) {
				if (!draft.includes(markerOf(id))) store.quotes.delete(id);
			}
			if (store.quotes.size === 0) store.nextId = 1;
		} catch {
			/* keep blocks when the editor is unreadable */
		}
		dbg(`session_start: mode=${ctx.mode} live blocks=${store.quotes.size} nextId=${store.nextId}`);
		currentCtx = ctx;
		cachedLines = undefined;
		foldOverride = undefined;
		installWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		dbg("session_shutdown: widget removed (block state kept in shared store)");
		cachedRenderer = undefined; // renderer belongs to the old TUI session
		currentCtx?.ui.setWidget(WIDGET_KEY, undefined);
		requestRender = undefined;
	});
}
