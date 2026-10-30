import { describe, expect, it } from "vitest";
import {
	MIN_PI_VERSION,
	REVIEWED_PI_VERSIONS,
	SHORTCUT,
	expandMarker,
	formatQuote,
	stripMarkers,
	versionAtLeast,
} from "../quote-blocks";

describe("formatQuote", () => {
	it("prefixes every line with > ", () => {
		expect(formatQuote("a\nb")).toBe("> a\n> b");
	});

	it("renders blank lines as a bare >", () => {
		expect(formatQuote("a\n\nb")).toBe("> a\n>\n> b");
	});

	it("normalizes CRLF and lone CR", () => {
		expect(formatQuote("a\r\nb\rc")).toBe("> a\n> b\n> c");
	});

	it("trims leading/trailing blank lines", () => {
		expect(formatQuote("\n\na\n\n")).toBe("> a");
	});

	it("returns empty string for whitespace-only text", () => {
		expect(formatQuote("  \n \t ")).toBe("");
	});
});

describe("expandMarker", () => {
	it("pads a mid-sentence marker with blank lines on both sides", () => {
		expect(expandMarker("ask [Q1]?", "[Q1]", "> line")).toBe("ask \n\n> line\n\n?");
	});

	it("does not add a leading blank at line start", () => {
		expect(expandMarker("[Q1] ok", "[Q1]", "> line")).toBe("> line\n\n ok");
	});

	it("does not add a trailing blank at end of text", () => {
		expect(expandMarker("see [Q1]", "[Q1]", "> line")).toBe("see \n\n> line");
	});

	it("avoids double blank lines when followed by a newline", () => {
		expect(expandMarker("a [Q1]\nb", "[Q1]", "> line")).toBe("a \n\n> line\n\nb");
	});

	it("expands every occurrence of the marker", () => {
		expect(expandMarker("[Q1] x [Q1]", "[Q1]", "> q")).toBe("> q\n\n x \n\n> q");
	});

	it("returns the text unchanged when the marker is absent", () => {
		expect(expandMarker("no marker here", "[Q1]", "> q")).toBe("no marker here");
	});
});

describe("stripMarkers", () => {
	it("removes a marker between words, keeping one space", () => {
		expect(stripMarkers("foo [Q1] bar", ["[Q1]"])).toBe("foo bar");
	});

	it("removes a leading marker and its trailing space", () => {
		expect(stripMarkers("[Q1] foo", ["[Q1]"])).toBe("foo");
	});

	it("removes a trailing marker and its leading space", () => {
		expect(stripMarkers("foo [Q1]", ["[Q1]"])).toBe("foo");
	});

	it("collapses adjacent marker runs to one space", () => {
		expect(stripMarkers("a [Q1][Q2] b", ["[Q1]", "[Q2]"])).toBe("a b");
		expect(stripMarkers("a [Q1] [Q2] b", ["[Q1]", "[Q2]"])).toBe("a b");
	});

	it("never touches spacing elsewhere (the /quotes clear regression)", () => {
		const draft = "[Q1] keep:\n    if (x) {\n        return;\n    }";
		expect(stripMarkers(draft, ["[Q1]"])).toBe("keep:\n    if (x) {\n        return;\n    }");
		expect(stripMarkers("two  spaces  stay", [])).toBe("two  spaces  stay");
	});

	it("does not shrink spacing beyond what surrounded the marker", () => {
		// 4 surrounding spaces → 3: monotone reduction, never expansion.
		expect(stripMarkers("a  [Q1]  b", ["[Q1]"])).toBe("a   b");
	});

	it("is not confused by numeric prefixes ([Q1] vs [Q10])", () => {
		expect(stripMarkers("[Q10] and [Q1]", ["[Q1]", "[Q10]"])).toBe("and");
		expect(stripMarkers("plain [Q3] text", ["[Q1]"])).toBe("plain [Q3] text");
	});

	it("removes markers at line starts across multiple lines", () => {
		expect(stripMarkers("x [Q1]\ny [Q2]\n", ["[Q1]", "[Q2]"])).toBe("x\ny\n");
	});
});

describe("versionAtLeast", () => {
	it("accepts equal versions", () => {
		expect(versionAtLeast("1.0.3", "1.0.3")).toBe(true);
	});

	it("compares numerically, not lexically", () => {
		expect(versionAtLeast("1.10.0", "1.9.0")).toBe(true);
		expect(versionAtLeast("1.0.2", "1.0.3")).toBe(false);
	});

	it("treats missing segments as zero", () => {
		expect(versionAtLeast("1.4", "1.4.0")).toBe(true);
		expect(versionAtLeast("1.4", "1.4.1")).toBe(false);
	});

	it("ignores prerelease suffixes", () => {
		expect(versionAtLeast("1.4.0-beta.1", "1.4.0")).toBe(true);
	});
});

describe("constants", () => {
	it("keeps the documented surface stable", () => {
		expect(SHORTCUT).toBe("alt+q");
		expect(MIN_PI_VERSION).toBe("1.0.3");
		expect(REVIEWED_PI_VERSIONS).toContain("1.4.0");
	});
});
