import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import factory, { keysFor } from "../quote-blocks";

/** Minimal mock of the extension runtime: captures registrations. */
function harness() {
	const shortcuts: Record<string, { description: string; handler: (ctx: unknown) => Promise<void> }> = {};
	const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const events: Record<string, (event: unknown, ctx?: unknown) => Promise<unknown>> = {};

	let draft = "";
	const notes: Array<[string, string]> = [];
	let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	let editorNext: string | undefined; // undefined = cancelled; "unsupported" = no ctx.ui.editor
	const editorCalls: Array<[string, string | undefined]> = [];
	const selectQueue: Array<string | undefined> = [];
	const confirmQueue: Array<boolean> = [];
	const selectCalls: Array<[string, string[]]> = [];
	const customKeys: string[] = [];
	let customModeCurrent: "custom" | "select-fallback" = "custom";
	let customCalls = 0;
	let customResult: unknown;
	let customRenderLinesCurrent: string[] = [];

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		ui: {
			theme: { fg: (_c: string, t: string) => t },
			setWidget: (_key: string, content: unknown) => {
				if (typeof content === "function") widgetFactory = content as typeof widgetFactory;
			},
			getEditorText: () => draft,
			setEditorText: (t: string) => {
				draft = t;
			},
			pasteToEditor: (t: string) => {
				draft += t;
			},
			notify: (message: string, type?: string) => notes.push([type ?? "info", message]),
			select: (title: string, options: string[]) => {
				selectCalls.push([title, options]);
				return Promise.resolve(selectQueue.shift());
			},
			confirm: (_title: string, _message: string) => Promise.resolve(confirmQueue.shift() ?? false),
			get custom() {
				if (customModeCurrent === "select-fallback") return undefined;
				return (
					factory: (
						tui: { requestRender(): void },
						theme: { fg(_c: string, t: string): string },
						keybindings: { matches(data: string, action: string): boolean },
						done: (result: unknown) => void,
					) => { render(width: number): string[]; handleInput(data: string): void; invalidate(): void },
				) => {
					customCalls += 1;
					customResult = undefined;
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_c, t) => t },
						{ matches: (data, action) => data === action },
						(result) => {
							customResult = result;
						},
					);
					for (const key of customKeys.splice(0)) component.handleInput(key);
					customRenderLinesCurrent = component.render(80);
					return Promise.resolve(customResult);
				};
			},
			get editor() {
				return editorNext === "unsupported"
					? undefined
					: (title: string, prefill?: string) => {
							editorCalls.push([title, prefill]);
							return editorNext;
						};
			},
		},
		sessionManager: {
			getBranch: () =>
				branch as Array<Record<string, unknown>>,
		},
	};
	let branch: Array<Record<string, unknown>> = [];

	const pi = {
		registerShortcut: (key: string, def: { description: string; handler: (ctx: unknown) => Promise<void> }) => {
			shortcuts[key] = def;
		},
		registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = def;
		},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) => {
			events[event] = handler;
		},
	};
	factory(pi as unknown as ExtensionAPI);

	return {
		shortcuts,
		commands,
		events,
		ctx,
		notes,
		editorCalls,
		selectCalls,
		selectQueue,
		confirmQueue,
		customKeys,
		get customCalls() {
			return customCalls;
		},
		get customRenderLines() {
			return customRenderLinesCurrent;
		},
		set customMode(mode: "custom" | "select-fallback") {
			customModeCurrent = mode;
		},
		get draft() {
			return draft;
		},
		set draft(value: string) {
			draft = value;
		},
		set branch(value: Array<Record<string, unknown>>) {
			branch = value;
		},
		set editorNext(value: string | undefined) {
			editorNext = value;
		},
		render(width = 80): string[] {
			if (!widgetFactory) throw new Error("widget not installed");
			return widgetFactory!({ requestRender: () => {} }, ctx.ui.theme).render(width);
		},
		lastNote: () => notes[notes.length - 1]?.[1] ?? "",
	};
}

describe("shortcut configuration (PI_QUOTE_KEY_*)", () => {
	const ENV_VARS = ["PI_QUOTE_KEY_QUOTE", "PI_QUOTE_KEY_FOLD", "PI_QUOTE_KEY_MANAGE"] as const;

	afterEach(() => {
		for (const name of ENV_VARS) delete process.env[name];
	});

	it("defaults to alt+q / alt+h / alt+e", () => {
		expect(keysFor("quote")).toEqual(["alt+q"]);
		expect(keysFor("fold")).toEqual(["alt+h"]);
		expect(keysFor("manage")).toEqual(["alt+e"]);
	});

	it("env override: single key, comma list, normalization, empty fallback", () => {
		process.env.PI_QUOTE_KEY_FOLD = "ctrl+alt+f";
		expect(keysFor("fold")).toEqual(["ctrl+alt+f"]);

		process.env.PI_QUOTE_KEY_FOLD = " Alt+R , alt+r , ctrl+alt+j ";
		expect(keysFor("fold")).toEqual(["alt+r", "ctrl+alt+j"]); // trimmed, lowercased, deduped

		process.env.PI_QUOTE_KEY_FOLD = "  ";
		expect(keysFor("fold")).toEqual(["alt+h"]); // empty → default
	});

	it("configured keys are what get registered", () => {
		process.env.PI_QUOTE_KEY_MANAGE = "alt+m,ctrl+alt+m";
		const h = harness();
		expect(Object.keys(h.shortcuts)).toEqual(
			expect.arrayContaining(["alt+m", "ctrl+alt+m"]),
		);
		expect(Object.keys(h.shortcuts)).not.toContain("alt+e");
	});

	it("configured alt+shift+letter warns as a dead binding at session start", async () => {
		process.env.PI_QUOTE_KEY_MANAGE = "alt+shift+e";
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		const warning = h.notes.find(([type]) => type === "warning")?.[1] ?? "";
		expect(warning).toContain("alt+shift+e");
		expect(warning).toContain("dead");
	});
});

describe("extension factory", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fold binding: alt+h parses everywhere and is free of pi built-ins; alt+shift+q stays dead", () => {
		// Snapshot of pi 1.4.0 default alt+* keys (KEYBINDINGS: TUI editor
		// readline-style keys + app actions + Windows variants). Re-verify when
		// REVIEWED_PI_VERSIONS gains a version.
		const builtinAltKeys = [
			"alt+b", "alt+backspace", "alt+d", "alt+delete", "alt+down", "alt+enter",
			"alt+f", "alt+left", "alt+right", "alt+up", "alt+y",
			"alt+q", "alt+p", "alt+v", "alt+z", // Windows/WSL variants
		];
		expect(builtinAltKeys).toContain("alt+f"); // the collision that moved the default
		expect(builtinAltKeys).not.toContain("alt+h");
		expect(builtinAltKeys).not.toContain("alt+e");
		expect(matchesKey("\x1bh", "alt+h")).toBe(true);
		// Verified against pi-tui 1.4.0's matcher:
		// - legacy: ESC + uppercase Q has no key id
		// - kitty "\x1b[113:81;3u"/"\x1b[113;3u" normalize the shifted letter
		//   back to lowercase and match alt+q (quote selection!), not alt+shift+q
		// - kitty "\x1b[81;3u" matches nothing
		expect(matchesKey("\x1bQ", "alt+shift+q")).toBe(false);
		expect(matchesKey("\x1bQ", "alt+shift+q")).toBe(false);
		expect(matchesKey("\x1b[113:81;3u", "alt+shift+q")).toBe(false);
		expect(matchesKey("\x1b[113;3u", "alt+shift+q")).toBe(false);
		expect(matchesKey("\x1b[81;3u", "alt+shift+q")).toBe(false);
		expect(matchesKey("\x1b[113:81;3u", "alt+q")).toBe(true); // the collision
	});

	it("registers shortcuts, commands, and lifecycle events", () => {
		const h = harness();
		expect(Object.keys(h.shortcuts)).toEqual(
			expect.arrayContaining(["alt+q", "alt+e", "alt+h"]),
		);
		expect(Object.keys(h.shortcuts)).not.toContain("alt+shift+q");
		expect(Object.keys(h.commands)).toEqual(
			expect.arrayContaining(["quote", "quotes"]),
		);
		expect(Object.keys(h.commands)).not.toContain("quote-selection");
		expect(Object.keys(h.events)).toEqual(
			expect.arrayContaining(["input", "session_start", "session_shutdown"]),
		);
	});

	it("/quote quotes the last assistant reply and inserts a marker", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal" },
						{ type: "text", text: "second L1\nL2" },
					],
				},
			},
		];
		await h.commands.quote.handler("", h.ctx);
		expect(h.draft).toBe("[Q1]");
		expect(h.lastNote()).toContain("Q1");
		expect(h.lastNote()).toContain("reply -1");

		await h.commands.quote.handler("2", h.ctx);
		expect(h.draft).toBe("[Q1][Q2]");
	});

	it("/quote rejects out-of-range indices with a helpful message", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "only" }] } }];
		await h.commands.quote.handler("5", h.ctx);
		expect(h.lastNote()).toContain("Only 1 assistant message");
		expect(h.draft).toBe("");
	});

	it("/quotes remove deletes the block and strips its marker only", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
		];
		await h.commands.quote.handler("2", h.ctx); // Q1 = "one"
		await h.commands.quote.handler("", h.ctx); // Q2 = "two"
		h.draft = "keep  double  spacing [Q1] and [Q2] done";
		await h.commands.quotes.handler("remove q2", h.ctx);
		expect(h.draft).toBe("keep  double  spacing [Q1] and done");
		expect(h.lastNote()).toBe("Block Q2 removed");
	});

	it("/quotes edit updates block text; emptied text removes the block", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "original" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.draft = "[Q1] question";

		h.editorNext = "trimmed";
		await h.commands.quotes.handler("edit 1", h.ctx);
		expect(h.editorCalls[0]?.[0]).toContain("Q1");
		expect(h.lastNote()).toContain("updated");
		expect(h.render().some((line) => line.includes("trimmed"))).toBe(true);

		h.editorNext = ""; // emptied → remove
		await h.commands.quotes.handler("edit q1", h.ctx);
		expect(h.lastNote()).toContain("removed");
	});

	it("/quotes preview shows the expanded submit text without consuming blocks", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "quoted" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.draft = "about [Q1]";

		h.editorNext = undefined; // dialog cancelled → returns undefined
		await h.commands.quotes.handler("preview", h.ctx);
		expect(h.editorCalls[0]?.[1]).toContain("> quoted");
		// block still alive: preview must not consume it
		const result = (await h.events.input({ source: "prompt", text: h.draft })) as {
			action: string;
			text: string;
		};
		expect(result.action).toBe("transform");
		expect(result.text).toContain("> quoted");
	});

	it("input transform expands markers and drops unreferenced blocks", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "alpha" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "beta" }] } },
		];
		await h.commands.quote.handler("2", h.ctx); // Q1 = alpha
		await h.commands.quote.handler("", h.ctx); // Q2 = beta
		h.draft = "only [Q1] here";

		const result = (await h.events.input({ source: "prompt", text: h.draft })) as {
			action: string;
			text: string;
		};
		expect(result.action).toBe("transform");
		expect(result.text).toBe("only \n\n> alpha\n\n here");
		expect(h.render()).toEqual([]); // Q2 dropped, widget empty
	});

	it("input without blocks continues unchanged", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		const result = (await h.events.input({ source: "prompt", text: "plain" })) as { action: string };
		expect(result.action).toBe("continue");
	});

	it("widget renders cards in draft anchor order", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "aaa" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "bbb" }] } },
		];
		await h.commands.quote.handler("2", h.ctx); // Q1 = aaa
		await h.commands.quote.handler("", h.ctx); // Q2 = bbb
		h.draft = "later [Q2] first, then [Q1]";

		const headers = h.render().filter((line) => line.startsWith("❝"));
		expect(headers[0]).toContain("Q2");
		expect(headers[1]).toContain("Q1");
	});

	it("bare /quotes opens the Alt+E manager (menu-discoverable path)", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.draft = "about [Q1]";
		h.customKeys.push("tui.select.cancel");
		await h.commands.quotes.handler("", h.ctx);
		expect(h.selectCalls).toHaveLength(0); // picker is the custom component
		expect(h.customRenderLines.join("\n")).toContain("Q1");
		expect(h.customRenderLines.join("\n")).toContain("clear all blocks");
		expect(h.draft).toBe("about [Q1]"); // untouched
	});

	it("Alt+E picker previews the full multi-line content of the highlighted block", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first line here" }] } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "L1\nL2\nL3" }] },
			},
		];
		await h.commands.quote.handler("2", h.ctx); // Q1 = single line
		await h.commands.quote.handler("", h.ctx); // Q2 = three lines, highlighted after ↓
		h.customKeys.push("tui.select.down", "tui.select.cancel");
		await h.shortcuts["alt+e"].handler(h.ctx);
		const preview = h.customRenderLines.join("\n");
		expect(preview).toContain("L1");
		expect(preview).toContain("L2");
		expect(preview).toContain("L3"); // every line visible, not just the first
	});

	it("picker falls back to ctx.ui.select when ctx.ui.custom is unavailable", async () => {
		const h = harness();
		h.customMode = "select-fallback";
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "solo" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.selectQueue.push("Q1 · 1 lines · solo", undefined); // pick block, cancel action menu
		await h.shortcuts["alt+e"].handler(h.ctx);
		expect(h.customCalls).toBe(0);
		expect(h.selectCalls).toHaveLength(2); // picker + action menu
		expect(h.selectCalls[0]?.[1]).toContain("── clear all blocks ──");
	});

	it("picker window keeps a fixed height regardless of quote length", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "short" }] } }];
		await h.commands.quote.handler("", h.ctx);

		h.customKeys.push("tui.select.cancel");
		await h.shortcuts["alt+e"].handler(h.ctx);
		const shortRows = h.customRenderLines.length;

		// same block, now 8 lines long — window must not grow
		h.editorNext = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
		await h.commands.quotes.handler("edit q1", h.ctx);
		h.customKeys.push("tui.select.cancel");
		await h.shortcuts["alt+e"].handler(h.ctx);

		expect(h.customRenderLines.length).toBe(shortRows);
		const preview = h.customRenderLines.join("\n");
		expect(preview).toContain("five"); // first 5 source lines fit
		expect(preview).toContain("+3 more lines"); // 8 - 5 shown
		expect(preview).not.toContain("seven"); // beyond the budget
	});

	it("pick-view hotkeys: r removes, i re-inserts, e edits without the action view", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
		];
		await h.commands.quote.handler("2", h.ctx); // Q1 = one
		await h.commands.quote.handler("", h.ctx); // Q2 = two
		h.draft = "a [Q1] b [Q2] c";

		h.customKeys.push("tui.select.down", "r"); // highlight Q2, remove it
		await h.shortcuts["alt+e"].handler(h.ctx);
		expect(h.draft).toBe("a [Q1] b c");
		expect(h.lastNote()).toBe("Block Q2 removed");
		expect(h.selectCalls).toHaveLength(0);

		h.draft = "text";
		h.customKeys.push("i"); // highlight Q1 (first row), insert its marker
		await h.shortcuts["alt+e"].handler(h.ctx);
		expect(h.draft).toBe("text[Q1]");
		expect(h.lastNote()).toBe("Inserted [Q1]");

		h.editorNext = "edited";
		h.customKeys.push("e"); // edit Q1 directly
		await h.shortcuts["alt+e"].handler(h.ctx);
		expect(h.editorCalls.at(-1)?.[1]).toBe("one");
		expect(h.lastNote()).toContain("updated");
	});

	it("letters are inert on the clear-all row", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "only" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.draft = "[Q1] x";
		h.customKeys.push("tui.select.down", "r"); // clear-all row + r
		await h.shortcuts["alt+e"].handler(h.ctx);
		expect(h.draft).toBe("[Q1] x"); // nothing happened
		expect(h.lastNote()).not.toContain("removed");
	});

	it("window rows align: every rendered line has the same width", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "align me" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.customKeys.push("tui.select.cancel");
		await h.shortcuts["alt+e"].handler(h.ctx);
		const lengths = new Set(h.customRenderLines.map((line) => line.length));
		expect(lengths.size).toBe(1); // borders included — off-by-one fixed
	});

	it("Alt+E edits a block mid-composition without touching the draft", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "original" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.draft = "typing about [Q1] right now";

		h.customKeys.push("tui.select.confirm", "tui.select.confirm"); // pick Q1 → edit text (index 0)
		h.editorNext = "revised text";
		await h.shortcuts["alt+e"].handler(h.ctx);

		expect(h.draft).toBe("typing about [Q1] right now"); // dialogs never touch the draft
		expect(h.lastNote()).toContain("updated");
		expect(h.render().some((line) => line.includes("revised text"))).toBe(true);
	});

	it("Alt+E clear-all sentinel strips every marker", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
		];
		await h.commands.quote.handler("2", h.ctx);
		await h.commands.quote.handler("", h.ctx);
		h.draft = "keep  spacing [Q1] and [Q2] done";

		h.customKeys.push(
			"tui.select.down", // Q1 → Q2
			"tui.select.down", // Q2 → clear all
			"tui.select.confirm", // → confirm view (defaults to "no")
			"tui.select.up", // no → yes
			"tui.select.confirm", // clear
		);
		await h.shortcuts["alt+e"].handler(h.ctx);

		expect(h.draft).toBe("keep  spacing and done");
		expect(h.lastNote()).toBe("All quote blocks removed");
		expect(h.render()).toEqual([]);
	});

	it("Alt+E re-insert action puts the marker at the cursor", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } }];
		await h.commands.quote.handler("", h.ctx);
		h.draft = "text without marker";

		h.customKeys.push(
			"tui.select.confirm", // pick Q1
			"tui.select.down", // edit → remove
			"tui.select.down", // remove → insert
			"tui.select.confirm", // insert [Q1] at cursor
		);
		await h.shortcuts["alt+e"].handler(h.ctx);

		expect(h.draft).toBe("text without marker[Q1]");
	});

	it("deleting a marker from the draft prunes its card", async () => {
		const h = harness();
		await h.events.session_start({ type: "session_start" }, h.ctx);
		h.branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "aaa" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "bbb" }] } },
		];
		await h.commands.quote.handler("2", h.ctx);
		await h.commands.quote.handler("", h.ctx);
		h.draft = "only [Q1]";
		const lines = h.render();
		expect(lines.filter((line) => line.startsWith("❝"))).toHaveLength(1);
		expect(lines[0]).toContain("Q1");
	});
});
