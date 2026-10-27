/**
 * quote-blocks.ts — 引用块模式（Codex 风格，Alt+Q）
 *
 * 结构：输入框上方 widget 渲染引用块卡片，正文只放 [Qn] 短标记；
 * 发送（input 事件）时把标记展开为 "> 引用" 给模型。
 *
 * v3 修复（真 bug 排查）：
 *   - 块状态（quotes/nextId）搬到 globalThis[Symbol.for(...)]，
 *     同一进程内跨 /reload、跨模块重复实例化存活——排除「widget 实例
 *     和 input-handler 实例各持一份状态」导致发送时不展开的问题
 *   - 全链路调试日志（/tmp/quote-blocks-debug.log），带模块实例指纹，
 *     再出问题一眼定位是哪个环节断了
 *
 * 快捷键：Alt+Q 引用选区；Alt+Shift+Q 折叠/展开
 * 命令：/quote-selection（同 Alt+Q）· /quotes [clear|fold|unfold]
 * 折叠：卡片总行数 > PI_QUOTE_FOLD_LINES（默认 8）自动收成一行
 *
 * 选区获取改自 alandarev/pi-quote v0.1.2（MIT）；版本门 >= 1.0.3，
 * 渲染器/编辑器 API 运行时逐项探测。
 */

import * as fs from "node:fs";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const MIN_PI_VERSION = "1.0.3";
/** 已逐版人工验证的 Pi 版本（沿用上游纪律：每升一版，重验下述 API 后加入）。
 * 逃生门：PI_QUOTE_ALLOW_UNREVIEWED=1 跳过检查（自担风险）。 */
export const REVIEWED_PI_VERSIONS = ["1.0.3", "1.4.0"];
export const SHORTCUT = "alt+q";
const WIDGET_KEY = "quote-blocks";
const MAX_PREVIEW_LINES = 2;
const FOLD_THRESHOLD = Number(process.env.PI_QUOTE_FOLD_LINES ?? 8);
const DEBUG_LOG = process.env.PI_QUOTE_DEBUG_LOG ?? "/tmp/quote-blocks-debug.log";
/** 调试日志：PI_QUOTE_DEBUG=1 时才写，默认零 I/O */
const DEBUG = process.env.PI_QUOTE_DEBUG === "1";

/** 模块实例指纹：排查多实例分裂用 */
const INSTANCE = Math.random().toString(36).slice(2, 8);
const dbg = (message: string): void => {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${INSTANCE}] ${message}\n`);
	} catch {
		/* 日志失败不影响功能 */
	}
};
dbg("module evaluated");

// ---- 跨实例共享状态（globalThis，同进程内 /reload 存活） ----

interface QuoteStore {
	quotes: Map<number, string>;
	nextId: number;
}
const STORE = Symbol.for("pi.quoteBlocks.store");

function sharedStore(): QuoteStore {
	const g = globalThis as Record<symbol, QuoteStore | undefined>;
	if (!g[STORE]) {
		g[STORE] = { quotes: new Map(), nextId: 1 };
		dbg(`store created (fresh)`);
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

/** 引用原文 → markdown 引用行（发给模型用的形态） */
export function formatQuote(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	if (!normalized.trim()) return "";
	return normalized
		.split("\n")
		.map((line) => (line.length ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * 把正文里的 [Qn] 标记替换为引用块，前后补空行。
 * 没空行的话，markdown 的 lazy continuation 会把批注文字吞进引用块里，
 * 导致引用和回复粘成一坨分不清（真 bug，2026-10-27 用户反馈）。
 */
export function expandMarker(text: string, marker: string, quote: string): string {
	if (!text.includes(marker)) return text;
	const parts = text.split(marker);
	return parts
		.map((part, idx) => {
			if (idx === 0) return part;
			let seg = "";
			const prev = parts[idx - 1];
			if (prev.length > 0 && !prev.endsWith("\n")) seg += "\n\n"; // 前侧：不在行首则空行分隔
			seg += quote;
			if (part.length > 0) {
				seg += "\n\n"; // 后侧：批注前空行，避免被吞进引用块
				if (part.startsWith("\n")) part = part.slice(1); // 已有换行则吞一个，避免双空行
			}
			return seg + part;
		})
		.join("");
}

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

function getRenderer(ctx: ExtensionContext): SelectionRenderer {
	let renderer: unknown;
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
	return candidate as SelectionRenderer;
}

export default function (pi: ExtensionAPI): void {
	dbg("factory invoked");
	const store = sharedStore();

	// ---- 实例内 UI 状态 ----
	let currentCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let cachedLines: string[] | undefined;
	let cachedWidth: number | undefined;
	/** 折叠状态：undefined = 自动；"expanded" / "folded" = 手动 */
	let foldOverride: "expanded" | "folded" | undefined;

	/** 分配块编号：块库为空时从 Q1 重新开始（跨发送/reload 不再累加） */
	function allocateId(): number {
		if (store.quotes.size === 0) store.nextId = 1;
		return store.nextId++;
	}

	const markerOf = (id: number): string => `[Q${id}]`;

	function invalidateWidget(): void {
		cachedLines = undefined;
		requestRender?.();
	}

	/** 正文里已无对应标记的引用块：移除。
	 * 注意：空草稿时绝不 prune——TUI 按回车后编辑器会先清空再触发 input 事件，
	 * 那个瞬间空草稿是提交动作而不是用户删标记（真 bug 根因，见日志 2026-10-27）。 */
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

	/** widget 渲染：无块 0 行；超阈值折叠一行 */
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
			store.quotes.size,
		);
		const shouldFold = foldOverride === "folded" || (foldOverride !== "expanded" && totalLines > FOLD_THRESHOLD);

		if (shouldFold) {
			const summary = `❝❝❝ ${store.quotes.size} quote blocks · ${totalLines} lines · alt+shift+q 展开`;
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

	// ---- Alt+Q：选区 → 引用块 ----
	async function quoteSelection(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (
			!versionAtLeast(VERSION, MIN_PI_VERSION) ||
			(!REVIEWED_PI_VERSIONS.includes(VERSION) && process.env.PI_QUOTE_ALLOW_UNREVIEWED !== "1")
		) {
			ctx.ui.notify(
				`Quote blocks: Pi ${VERSION} 未经验证（已验证：${REVIEWED_PI_VERSIONS.join(", ")}）。` +
					"验证后加入白名单，或设 PI_QUOTE_ALLOW_UNREVIEWED=1 强制启用。",
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

	// ---- 折叠切换：Alt+Shift+Q ----
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

	// ---- /quotes 管理 ----
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

	// ---- 发送时展开标记 ----
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
		// 发送文本是唯一依据：没被引用的块在此统一清除（提交竞态下编辑器已空，无法区分）
		if (store.quotes.size > 0) {
			dbg(`input: dropping unmatched [${[...store.quotes.keys()].join(",")}]`);
			store.quotes.clear();
		}
		if (store.quotes.size === 0) foldOverride = undefined;
		invalidateWidget();
		if (!changed) return { action: "continue" };
		dbg(`input: => transform (newLen=${text.length})`);
		return { action: "transform", text };
	});

	// ---- 生命周期 ----
	pi.on("session_start", async (_event, ctx) => {
		// 新会话（/new、/resume）编辑器为空，残留块无意义；/reload 时草稿还在，
		// 标记存活的块保留。此处允许空草稿判定（与 pruneQuotes 的提交竞态保护不同）。
		try {
			const draft = ctx.mode === "tui" ? ctx.ui.getEditorText() : "";
			for (const id of [...store.quotes.keys()]) {
				if (!draft.includes(markerOf(id))) store.quotes.delete(id);
			}
			if (store.quotes.size === 0) store.nextId = 1;
		} catch {
			/* 保守起见保留 */
		}
		dbg(`session_start: mode=${ctx.mode} live blocks=${store.quotes.size} nextId=${store.nextId}`);
		currentCtx = ctx;
		cachedLines = undefined;
		foldOverride = undefined;
		installWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		dbg("session_shutdown: widget removed (block state kept in shared store)");
		currentCtx?.ui.setWidget(WIDGET_KEY, undefined);
		requestRender = undefined;
	});
}
