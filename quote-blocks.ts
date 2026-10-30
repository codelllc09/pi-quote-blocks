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
 * Shortcuts: Alt+Q quote selection; Alt+F fold/expand; Alt+E manage
 * Fallback:  Alt+Q with no readable selection quotes the system clipboard
 *            (Pi copy-on-select keeps it in sync); PI_QUOTE_CLIPBOARD=0 off
 * Commands:  /quote [n] (nth-last assistant reply) · /quotes (opens the Alt+E
 *            manager; subcommands clear|fold|unfold|edit|remove|preview)
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

import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const MIN_PI_VERSION = "1.0.3";
/** Pi versions verified against the renderer/editor APIs used below.
 * Re-verify after each Pi release before adding it here. */
export const REVIEWED_PI_VERSIONS = ["1.0.3", "1.4.0"];
export const SHORTCUT = "alt+q";
const WIDGET_KEY = "quote-blocks";
const MAX_PREVIEW_LINES = 2;
const foldThresholdEnv = Number.parseInt(process.env.PI_QUOTE_FOLD_LINES ?? "", 10);
/** Auto-fold beyond this many card lines. Invalid or missing env falls back to 8
 * (a NaN threshold would make the comparison always false and silently kill folding). */
const FOLD_THRESHOLD = Number.isFinite(foldThresholdEnv) ? foldThresholdEnv : 8;
/** Clipboard fallback for Alt+Q when live selection is unavailable
 * (unreviewed Pi version, regular mode, renderer API change). */
const CLIPBOARD_FALLBACK = process.env.PI_QUOTE_CLIPBOARD !== "0";
const DEBUG_LOG = process.env.PI_QUOTE_DEBUG_LOG ?? "/tmp/quote-blocks-debug.log";
/** Debug log: only written when PI_QUOTE_DEBUG=1; zero I/O otherwise. */
const DEBUG = process.env.PI_QUOTE_DEBUG === "1";

/** Random per-module-instance fingerprint, for split-instance diagnosis. */
const INSTANCE = Math.random().toString(36).slice(2, 8);
const execFileAsync = promisify(execFileCb);
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
		for (const method of ["getActiveSelectionText", "clearTextSelection", "requestRender", "hasOverlay"] as const) {
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
	] as const) {
		if (typeof candidate[method] !== "function") {
			throw new Error(`Quote blocks unavailable: Pi renderer API changed (${method}).`);
		}
	}
	cachedRenderer = candidate as SelectionRenderer;
	dbg("renderer acquired and cached (one-time bridge)");
	return cachedRenderer;
}

// ---- Clipboard fallback (public-API path; no renderer internals) ----

type ClipboardCommand = { cmd: string; args: string[] };

/** Candidate readers in preference order. Pi's fullscreen copy-on-select
 * (default on) keeps the system clipboard in sync with the latest transcript
 * selection, so this covers unreviewed Pi versions and regular mode. */
function clipboardCandidates(): ClipboardCommand[] {
	switch (process.platform) {
		case "darwin":
			return [{ cmd: "pbpaste", args: [] }];
		case "win32":
			return [{ cmd: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] }];
		default:
			return [
				...(process.env.TERMUX_VERSION ? [{ cmd: "termux-clipboard-get", args: [] }] : []),
				...(process.env.WAYLAND_DISPLAY ? [{ cmd: "wl-paste", args: ["--no-newline"] }] : []),
				{ cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
				{ cmd: "xsel", args: ["-ob"] },
			];
	}
}

let cachedClipboardReader: ClipboardCommand | undefined;

/** Best-effort clipboard read: "" when unreadable or empty. The first reader
 * that returns text is cached; empty results keep probing next time (on some
 * setups an empty clipboard is indistinguishable from a missing tool). */
async function readClipboard(): Promise<string> {
	const candidates = cachedClipboardReader ? [cachedClipboardReader] : clipboardCandidates();
	for (const candidate of candidates) {
		try {
			const { stdout } = await execFileAsync(candidate.cmd, candidate.args, { timeout: 1500 });
			if (stdout.trim()) {
				cachedClipboardReader = candidate;
				return stdout;
			}
		} catch {
			/* missing tool or empty clipboard — try the next candidate */
		}
	}
	return "";
}

type ThemeLike = {
	fg(color: string, text: string): string;
};

export function versionAtLeast(a: string, b: string): boolean {
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

/** Remove `[Qn]` markers from a draft. A marker run ("[Q1] [Q2]") is removed
 * whole and takes at most one adjacent space with it, so spacing the user
 * typed elsewhere — code indentation in particular — is never touched. */
export function stripMarkers(draft: string, markers: string[]): string {
	if (markers.length === 0) return draft;
	const alt = [...new Set(markers)]
		.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	// A whole run is one match; the callback keeps exactly one of the spaces
	// that may surround it, so unrelated spacing is never squeezed.
	return draft.replace(new RegExp(` ?(?:${alt})(?: ?(?:${alt}))* ?`, "g"), (match) => {
		const hasLead = match.startsWith(" ");
		const hasTrail = match.endsWith(" ");
		return hasLead && hasTrail ? " " : "";
	});
}

/** Insert a marker at the editor cursor. Prefers the public pasteToEditor()
 * (bracketed paste — lands at the cursor exactly like a real paste); Pi
 * versions without it fall back to appending at the draft end. */
function insertMarker(ctx: ExtensionContext, marker: string): void {
	const ui = ctx.ui as ExtensionUIContext & { pasteToEditor?: (text: string) => void };
	if (typeof ui.pasteToEditor === "function") {
		ui.pasteToEditor(marker);
		dbg(`insertMarker: pasted ${marker} at cursor`);
		return;
	}
	const draft = ctx.ui.getEditorText();
	ctx.ui.setEditorText(`${draft}${draft.endsWith("\n") || !draft ? "" : " "}${marker} `);
	dbg(`insertMarker: appended ${marker} (no pasteToEditor)`);
}

export default function (pi: ExtensionAPI): void {
	dbg("factory invoked");
	const store = sharedStore();

	// ---- Per-instance UI state ----
	let currentCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let cachedLines: string[] | undefined;
	let cachedWidth: number | undefined;
	let cachedOrderKey: string | undefined;
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
		cachedOrderKey = undefined;
		requestRender?.();
	}

	/** Best-effort current editor text ("" when unavailable). */
	function currentDraft(): string {
		if (!currentCtx) return "";
		try {
			return currentCtx.ui.getEditorText();
		} catch {
			return "";
		}
	}

	/** Drop blocks whose markers are no longer in the draft.
	 * Never prune when the draft is empty: on submit the editor is cleared
	 * before the input event fires, so an empty draft means "submitting". */
	function pruneQuotes(draft: string): boolean {
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
		const draft = currentDraft();
		if (pruneQuotes(draft)) cachedLines = undefined;
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
			const summary = `❝❝❝ ${store.quotes.size} quote blocks · ${totalLines} lines · alt+f expand`;
			const line = truncateToWidth(fg("accent", summary), width, fg("dim", "…"));
			cachedWidth = width;
			cachedLines = [line];
			return cachedLines;
		}

		// Cards follow marker order in the draft (anchor order), not insertion
		// order; the order signature keeps the render cache honest.
		const orderKey = [...store.quotes.keys()].map((id) => draft.indexOf(markerOf(id))).join(",");
		if (cachedLines && cachedWidth === width && cachedOrderKey === orderKey && cachedLines.length > 1) {
			return cachedLines;
		}

		const ordered = [...store.quotes.entries()].sort(
			(a, b) => draft.indexOf(markerOf(a[0])) - draft.indexOf(markerOf(b[0])),
		);
		const lines: string[] = [];
		for (const [id, raw] of ordered) {
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
		cachedOrderKey = orderKey;
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

	// ---- Alt+Q: selection (or clipboard) → quote block ----
	async function quoteSelection(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const reviewed =
			versionAtLeast(VERSION, MIN_PI_VERSION) &&
			(REVIEWED_PI_VERSIONS.includes(VERSION) || process.env.PI_QUOTE_ALLOW_UNREVIEWED === "1");

		let raw = "";
		let source = "";
		let failure = "";
		if (reviewed) {
			try {
				const renderer = getRenderer(ctx);
				if (renderer.hasOverlay()) {
					failure = "Close Pi dialog before quoting transcript selection.";
				} else {
					const selected = renderer.getActiveSelectionText();
					raw = typeof selected === "string" ? selected.replace(/\r\n?/g, "\n").trim() : "";
					if (raw) source = "selection";
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
		} else {
			failure =
				`Pi ${VERSION} is not reviewed (reviewed: ${REVIEWED_PI_VERSIONS.join(", ")}) — ` +
				"live selection disabled; clipboard fallback only.";
		}

		if (!raw && CLIPBOARD_FALLBACK) {
			// Pi's fullscreen copy-on-select (default on) mirrors the latest
			// transcript selection into the system clipboard, so reading it is a
			// public-API path that needs no renderer internals.
			const clip = (await readClipboard()).replace(/\r\n?/g, "\n").trim();
			if (clip) {
				raw = clip;
				source = "clipboard";
			}
		}

		if (!raw) {
			const hint = CLIPBOARD_FALLBACK
				? "Select transcript text with mouse (or copy text to clipboard), then press Alt+Q."
				: "Select transcript text with mouse, then press Alt+Q.";
			ctx.ui.notify(failure ? `${failure} ${hint}` : hint, "warning");
			dbg(`Alt+Q: no text (${failure || "no selection, empty clipboard"})`);
			return;
		}

		createBlock(ctx, raw, source);
	}

	/** Store `raw` as a new block, insert its marker at the cursor, announce it. */
	function createBlock(ctx: ExtensionContext, raw: string, source: string): void {
		const id = allocateId();
		store.quotes.set(id, raw);
		insertMarker(ctx, markerOf(id));
		if (source === "selection") {
			try {
				const renderer = getRenderer(ctx);
				renderer.clearTextSelection();
				renderer.requestRender();
			} catch {
				/* selection cleanup is best-effort */
			}
		}
		invalidateWidget();
		const lines = raw.split("\n").length;
		ctx.ui.notify(`Quoted as block Q${id} (${lines} line${lines > 1 ? "s" : ""} · ${source})`, "info");
		dbg(`createBlock: Q${id} ${lines} lines from ${source}`);
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Quote selected text (or clipboard) as a block",
		handler: async (ctx) => quoteSelection(ctx),
	});

	// ---- Fold toggle: Alt+F ----
	function toggleFold(ctx: ExtensionContext): void {
		if (store.quotes.size === 0) {
			ctx.ui.notify("No quote blocks", "info");
			return;
		}
		foldOverride = foldOverride === "expanded" ? "folded" : "expanded";
		invalidateWidget();
		ctx.ui.notify(foldOverride === "expanded" ? "Quote blocks expanded" : "Quote blocks folded", "info");
	}

	pi.registerShortcut("alt+f", {
		description: "Fold / expand quote blocks",
		handler: async (ctx) => toggleFold(ctx),
	});
	// Alt+Shift+Q is NOT registered, verified against pi-tui 1.4.0's matcher:
	// - legacy encoding (ESC + uppercase Q) has no key id — matchesKey false
	// - kitty CSI-u forms ("\x1b[113:81;3u", "\x1b[113;3u") normalize the
	//   shifted letter back to lowercase and match alt+q instead — pressing
	//   Alt+Shift+Q there fires quote-selection, and ("\x1b[81;3u") matches
	//   nothing at all. A fold binding on this combo is dead or harmful
	//   everywhere; Alt+F is the only fold binding.

	// ---- /quote [n]: assistant reply from history → quote block ----
	/** Concatenated text blocks of an assistant message ("" when not one). */
	function assistantText(message: unknown): string {
		const m = message as { role?: string; content?: unknown } | null | undefined;
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
		const parts: string[] = [];
		for (const block of m.content as { type?: string; text?: unknown }[]) {
			if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
				parts.push(block.text);
			}
		}
		return parts.join("\n\n").trim();
	}

	async function quoteHistory(ctx: ExtensionContext, arg: string): Promise<void> {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.getEditorText(); // the marker needs an editable prompt
		} catch {
			ctx.ui.notify("/quote needs an editable prompt (TUI mode)", "warning");
			return;
		}
		const texts: string[] = [];
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry?.type !== "message") continue;
				const text = assistantText((entry as { message?: unknown }).message);
				if (text) texts.push(text);
			}
		} catch {
			/* unreadable history → treat as empty */
		}
		if (texts.length === 0) {
			ctx.ui.notify("No assistant messages in this session yet", "info");
			return;
		}
		let index = texts.length - 1; // default: last
		if (arg && arg.toLowerCase() !== "last") {
			const n = Number.parseInt(arg, 10);
			if (!Number.isInteger(n) || n < 1) {
				ctx.ui.notify("Usage: /quote [n] — n = nth-last assistant reply (default last)", "warning");
				return;
			}
			index = texts.length - n;
			if (index < 0) {
				ctx.ui.notify(
					`Only ${texts.length} assistant message${texts.length > 1 ? "s" : ""} in this session`,
					"warning",
				);
				return;
			}
		}
		const raw = texts[index].replace(/\r\n?/g, "\n").trim();
		if (!raw) {
			ctx.ui.notify("That reply has no text content", "info");
			return;
		}
		createBlock(ctx, raw, `reply -${texts.length - index}`);
	}

	pi.registerCommand("quote", {
		description: "Quote a past assistant reply as a block (/quote · /quote 2 = second-last)",
		handler: async (args, ctx) => quoteHistory(ctx, args.trim()),
	});

	// ---- /quotes management ----
	/** Parse "q3" / "3" → 3; undefined when not a block id. */
	const parseBlockId = (token: string | undefined): number | undefined => {
		const match = /^(?:q(\d+)|(\d+))$/.exec(token ?? "");
		if (!match) return undefined;
		return Number.parseInt(match[1] ?? match[2], 10);
	};

	/** Delete one block and its marker from the draft. */
	function removeBlock(ctx: ExtensionContext, id: number): boolean {
		if (!store.quotes.has(id)) return false;
		try {
			ctx.ui.setEditorText(stripMarkers(ctx.ui.getEditorText(), [markerOf(id)]));
		} catch {
			/* no editor — still drop the card */
		}
		store.quotes.delete(id);
		if (store.quotes.size === 0) {
			store.nextId = 1;
			foldOverride = undefined;
		}
		invalidateWidget();
		dbg(`remove: Q${id} deleted`);
		return true;
	}

	/** What submit would send for the current draft, without consuming blocks. */
	function expandedDraft(draft: string): string {
		let text = draft;
		for (const [id, raw] of store.quotes) {
			const marker = markerOf(id);
			if (!text.includes(marker)) continue;
			const quote = formatQuote(raw);
			text = quote ? expandMarker(text, marker, quote) : stripMarkers(text, [marker]);
		}
		return text;
	}

	/** Open ctx.ui.editor on a block's text; emptied text removes the block. */
	async function editBlock(ctx: ExtensionContext, id: number): Promise<void> {
		const raw = store.quotes.get(id);
		if (raw === undefined) {
			ctx.ui.notify(`No block Q${id}`, "warning");
			return;
		}
		if (typeof ctx.ui.editor !== "function") {
			ctx.ui.notify("Editing needs a pi version with ctx.ui.editor", "warning");
			return;
		}
		const edited = await ctx.ui.editor(`Edit quote block Q${id}`, raw);
		if (edited === undefined) return; // cancelled
		const clean = edited.replace(/\r\n?/g, "\n").trim();
		if (!clean) {
			removeBlock(ctx, id);
			ctx.ui.notify(`Block Q${id} emptied → removed`, "info");
			return;
		}
		store.quotes.set(id, clean);
		invalidateWidget();
		ctx.ui.notify(`Block Q${id} updated (${clean.split("\n").length} lines)`, "info");
	}

	/** Remove every block and its markers from the draft. */
	function clearAllBlocks(ctx: ExtensionContext): void {
		try {
			ctx.ui.setEditorText(
				stripMarkers(ctx.ui.getEditorText(), [...store.quotes.keys()].map((id) => markerOf(id))),
			);
		} catch {
			/* no editor — just drop the cards */
		}
		store.quotes.clear();
		store.nextId = 1;
		foldOverride = undefined;
		invalidateWidget();
		dbg("clear: all blocks removed");
		ctx.ui.notify("All quote blocks removed", "info");
	}

	pi.registerCommand("quotes", {
		description: "Manage quote blocks (opens the Alt+E manager; or clear/fold/unfold/edit/remove/preview)",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
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
				clearAllBlocks(ctx);
				return;
			}
			if (sub === "remove" || sub === "rm" || sub === "delete") {
				const id = parseBlockId(parts[1]);
				if (id === undefined) {
					ctx.ui.notify("Usage: /quotes remove Qn", "warning");
					return;
				}
				if (!store.quotes.size) {
					ctx.ui.notify("No quote blocks", "info");
					return;
				}
				if (!removeBlock(ctx, id)) {
					ctx.ui.notify(`No block Q${id}`, "warning");
					return;
				}
				ctx.ui.notify(`Block Q${id} removed`, "info");
				return;
			}
			if (sub === "edit") {
				const id = parseBlockId(parts[1]);
				if (id === undefined) {
					ctx.ui.notify("Usage: /quotes edit Qn", "warning");
					return;
				}
				if (!store.quotes.has(id)) {
					ctx.ui.notify(`No block Q${id}`, "warning");
					return;
				}
				await editBlock(ctx, id);
				return;
			}
			if (sub === "preview") {
				if (!store.quotes.size) {
					ctx.ui.notify("No quote blocks", "info");
					return;
				}
				const text = expandedDraft(currentDraft());
				if (typeof ctx.ui.editor === "function") {
					await ctx.ui.editor("Quote preview — Esc to close (edits are not applied)", text);
				} else {
					ctx.ui.notify(text, "info");
				}
				return;
			}
			// No args: open the Alt+E manager; notify-list when dialogs are unavailable.
			if (ctx.hasUI && ctx.mode === "tui") {
				await manageBlocks(ctx);
				return;
			}
			if (!store.quotes.size) {
				ctx.ui.notify("No quote blocks (select text + Alt+Q)", "info");
				return;
			}
			pruneQuotes(currentDraft());
			const list = [...store.quotes.entries()]
				.map(([id, raw]) => {
					const first = raw.split("\n")[0].trim().slice(0, 40);
					return `Q${id} · ${raw.split("\n").length} lines · ${first}`;
				})
				.join("\n");
			ctx.ui.notify(`Quote blocks:\n${list}`, "info");
		},
	});

	// ---- Alt+E: block manager ----
	// Slash commands only fire when the draft starts with "/", which is
	// exactly what you cannot do while composing. A shortcut can: the
	// dialogs overlay the editor and never touch the draft text.
	type PickTarget = { kind: "block"; id: number } | { kind: "clearAll" };
	type ManagerDecision =
		| { kind: "edit"; id: number }
		| { kind: "remove"; id: number }
		| { kind: "insert"; id: number }
		| { kind: "clear" };

	/** Block picker docked above the editor, preview pane floating above the
	 * list — the same place pi's native select appears, so browsing feels
	 * familiar. The whole flow lives in this one window (pick → action →
	 * confirm); only the multi-line text editor opens afterwards, after the
	 * window has closed (no dialog nesting).
	 *
	 * Ergonomics: fixed pane heights (moving the cursor only recolors one row
	 * and swaps preview text in place), dim wrapped preview, cursor row is
	 * the single accent element, title in the top border, hints in the bottom.
	 *
	 * Falls back to ctx.ui.select on pi versions without ctx.ui.custom(). */
	async function pickBlock(
		ctx: ExtensionContext,
		title: string,
		ordered: Array<[number, string]>,
	): Promise<ManagerDecision | undefined> {
		const targets: PickTarget[] = [
			...ordered.map(([id]): PickTarget => ({ kind: "block", id })),
			{ kind: "clearAll" },
		];
		const labelOf = (target: PickTarget): string => {
			if (target.kind === "clearAll") return "── clear all blocks ──";
			const lines = (store.quotes.get(target.id) ?? "").split("\n");
			return `Q${target.id} · ${lines.length} lines · ${lines[0].trim().slice(0, 40)}`;
		};
		const customFn: ExtensionUIContext["custom"] | undefined = (ctx.ui as Partial<ExtensionUIContext>).custom;
		if (!customFn) {
			const labels = targets.map(labelOf);
			const chosen = await ctx.ui.select(title, labels);
			if (chosen === undefined) return undefined;
			const index = labels.indexOf(chosen);
			if (index < 0) return undefined;
			const target = targets[index];
			if (target.kind === "clearAll") return { kind: "clear" };
			const actions = ["edit text", "remove block", `insert ${markerOf(target.id)} at cursor`];
			const action = await ctx.ui.select(`Block Q${target.id}`, actions);
			if (action === undefined) return undefined;
			if (action === actions[0]) return { kind: "edit", id: target.id };
			if (action === actions[1]) return { kind: "remove", id: target.id };
			return { kind: "insert", id: target.id };
		}
		const LIST_ROWS = 6; // list pane height (windowed when more targets)
		const PREVIEW_ROWS = 6; // preview pane height (padded when shorter)
		return customFn<ManagerDecision | undefined>(
			(tui, theme, keybindings, done) => {
				let view: "pick" | "action" | "confirm" = "pick";
				let pickIndex = 0;
				let actionIndex = 0;
				let confirmIndex = 1; // "no" first: clearing is destructive
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				const invalidate = () => {
					cachedWidth = undefined;
					cachedLines = undefined;
				};
				const activeId = (): number | undefined => {
					const target = targets[pickIndex];
					return target?.kind === "block" ? target.id : undefined;
				};
				const previewText = (): string[] => {
					const rows: string[] = [];
					const target = targets[pickIndex];
					if (view === "confirm" || target?.kind === "clearAll") {
						rows.push("Remove every quote block and its marker from the draft.");
						return rows;
					}
					const id = activeId();
					if (id === undefined) return rows;
					const content = (store.quotes.get(id) ?? "").replace(/\r\n?/g, "\n").split("\n");
					const budget = PREVIEW_ROWS - 1; // last row reserved for the "+N more" hint
					let used = 0;
					let consumed = 0;
					for (const source of content) {
						const wrapped = wrapTextWithAnsi(source.trim() || " ", innerFor(width()));
						if (used + wrapped.length > budget) break;
						rows.push(...wrapped);
						used += wrapped.length;
						consumed += 1;
					}
					const remaining = content.length - consumed;
					if (remaining > 0) {
						rows.push(`… +${remaining} more line${remaining > 1 ? "s" : ""} (edit shows all)`);
					}
					return rows;
				};
				// width memo for previewText (render is the only caller that knows it)
				let currentWidth = 72;
				const width = () => currentWidth;
				const innerFor = (w: number): number => Math.max(10, w - 4);
				return {
					render(w: number): string[] {
						currentWidth = w;
						if (cachedLines && cachedWidth === w) return cachedLines;
						const inner = innerFor(w);
						const pad = (line: string): string => {
							const clipped = truncateToWidth(line, inner, "…");
							return `│ ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} │`;
						};
						const borderRow = (left: string, right: string, label: string, style?: (t: string) => string): string => {
							const text = style ? style(label) : label;
							// clip first so over-long labels (narrow windows) never
							// overflow; fill then lands the right corner exactly on
							// the content edge (w-4 was one column short)
							const clipped = truncateToWidth(text, Math.max(1, w - 5), "…");
							const fill = Math.max(1, w - 3 - visibleWidth(clipped));
							return `${left}─${clipped}${"─".repeat(fill)}${right}`;
						};

						// ─ list pane (bottom, docked like the native selector) ─
						const listRows: string[] = [];
						let listStart = 0;
						if (view === "pick") {
							const windowRows = Math.min(LIST_ROWS, targets.length);
							listStart =
								targets.length <= LIST_ROWS
									? 0
									: Math.max(0, Math.min(pickIndex - (LIST_ROWS >> 1), targets.length - LIST_ROWS));
							for (let i = listStart; i < listStart + windowRows; i++) {
								const selected = i === pickIndex;
								const cursor = selected ? "❯ " : "  ";
								const label = selected ? theme.fg("accent", labelOf(targets[i])) : labelOf(targets[i]);
								listRows.push(pad(`${cursor}${label}`));
							}
						} else if (view === "action" && activeId() !== undefined) {
							const actions = [
								"edit text",
								"remove block",
								`insert ${markerOf(activeId() as number)} at cursor`,
								"back",
							];
							actions.forEach((action, i) => {
								const selected = i === actionIndex;
								const cursor = selected ? "❯ " : "  ";
								const label = selected ? theme.fg("accent", action) : action;
								listRows.push(pad(`${cursor}${label}`));
							});
						} else {
							const options = ["yes — remove all blocks", "no — keep them"];
							options.forEach((option, i) => {
								const selected = i === confirmIndex;
								const cursor = selected ? "❯ " : "  ";
								const label = selected ? theme.fg("accent", option) : option;
								listRows.push(pad(`${cursor}${label}`));
							});
						}
						while (listRows.length < LIST_ROWS) listRows.push(pad(""));

						// ─ preview pane (floating above the list) ─
						const previewRows = previewText();
						while (previewRows.length < PREVIEW_ROWS) previewRows.push("");

						const titleText =
							view === "pick" && targets.length > LIST_ROWS
								? ` ❝ ${title} · ${listStart + 1}–${listStart + Math.min(LIST_ROWS, targets.length)} of ${targets.length} `
								: ` ❝ ${title} `;
						const sectionLabel =
							view === "pick" ? " pick a block " : view === "action" ? " choose an action " : " confirm ";
						const hints =
							view === "pick"
								? " ↑↓ move · e edit · r remove · i insert · Esc cancel "
								: " ↑↓ move · Enter run · Esc back ";

						const lines = [
							borderRow("╭", "╮", titleText, (t) => theme.fg("accent", t)),
							...previewRows.map((row) => pad(theme.fg("dim", row))),
							borderRow("├", "┤", sectionLabel, (t) => theme.fg("dim", t)),
							...listRows,
							borderRow("╰", "╯", hints, (t) => theme.fg("dim", t)),
						];
						cachedWidth = w;
						cachedLines = lines;
						return lines;
					},
					handleInput(data: string): void {
							const move = (delta: number) => {
							if (view === "pick") pickIndex = (pickIndex + delta + targets.length) % targets.length;
							else if (view === "action") actionIndex = (actionIndex + delta + 4) % 4;
							else confirmIndex = (confirmIndex + delta + 2) % 2;
						};
						if (keybindings.matches(data, "tui.select.up")) {
							move(-1);
						} else if (keybindings.matches(data, "tui.select.down")) {
							move(1);
						} else if (view === "pick" && keybindings.matches(data, "tui.select.pageUp")) {
							pickIndex = Math.max(0, pickIndex - 5);
						} else if (view === "pick" && keybindings.matches(data, "tui.select.pageDown")) {
							pickIndex = Math.min(targets.length - 1, pickIndex + 5);
						} else if (keybindings.matches(data, "tui.select.confirm")) {
							if (view === "pick") {
								const target = targets[pickIndex];
								if (target.kind === "clearAll") {
									view = "confirm";
									confirmIndex = 1;
								} else {
									view = "action";
									actionIndex = 0;
								}
							} else if (view === "action") {
								const id = activeId();
								if (actionIndex === 3 || id === undefined) {
									view = "pick";
								} else if (actionIndex === 0) {
									done({ kind: "edit", id });
									return;
								} else if (actionIndex === 1) {
									done({ kind: "remove", id });
									return;
								} else {
									done({ kind: "insert", id });
									return;
								}
							} else if (confirmIndex === 0) {
								done({ kind: "clear" });
								return;
							} else {
								view = "pick";
							}
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							if (view === "pick") {
								done(undefined);
								return;
							}
							view = "pick";
						} else if (view === "pick" && data.length === 1) {
							// single-key accelerators on the highlighted block —
							// skip the action view entirely. Letters are inert on the
							// clear-all row (that path keeps its Enter → confirm
							// safeguard).
							const target = targets[pickIndex];
							if (target?.kind !== "block") return;
							const key = data.toLowerCase();
							if (key !== "e" && key !== "r" && key !== "i") return;
							const kind = key === "e" ? "edit" : key === "r" ? "remove" : "insert";
							done({ kind, id: target.id });
							return;
						} else {
							return;
						}
						invalidate();
						tui.requestRender();
					},
					invalidate,
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: "60%", minWidth: 46, maxHeight: 24, margin: 4 },
			},
		);
	}

	async function manageBlocks(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (!store.quotes.size) {
			ctx.ui.notify("No quote blocks (select text + Alt+Q)", "info");
			return;
		}
		const draft = currentDraft();
		const ordered = [...store.quotes.entries()].sort(
			(a, b) => draft.indexOf(markerOf(a[0])) - draft.indexOf(markerOf(b[0])),
		);
		const decision = await pickBlock(ctx, "Quote blocks", ordered);
		if (!decision) return; // Esc cancels
		if (decision.kind === "clear") {
			clearAllBlocks(ctx);
		} else if (decision.kind === "edit") {
			await editBlock(ctx, decision.id);
		} else if (decision.kind === "remove") {
			removeBlock(ctx, decision.id);
			ctx.ui.notify(`Block Q${decision.id} removed`, "info");
		} else {
			insertMarker(ctx, markerOf(decision.id));
			ctx.ui.notify(`Inserted ${markerOf(decision.id)}`, "info");
		}
	}

	pi.registerShortcut("alt+e", {
		description: "Manage quote blocks: preview, edit, remove, re-insert marker, or clear all",
		handler: async (ctx) => manageBlocks(ctx),
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
