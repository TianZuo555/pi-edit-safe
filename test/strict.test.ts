// Regression: ambiguity must throw, never silently pick the wrong occurrence.
// This is the opencode issue #1261 / #32559 class of bug — the tui.go case where
// multiple `}\n\n    return ...` blocks existed and the wrong one got edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits } from "../src/edit-replace.ts";

const FILE = `package main

func layoutA() {
	prepare()
	return layoutA
}

func layoutB() {
	prepare()
	return layoutB
}

func layoutC() {
	prepare()
	return layoutC
}
`;

test("ambiguous oldText that is not unique → throws (not silently edits first)", () => {
	// `prepare()` appears 3 times — not unique.
	assert.throws(
		() => applyEdits(FILE, [{ oldText: "\tprepare()", newText: "\tprepare(true)" }], "tui.go"),
		/not unique/i,
	);
});

test("overlapping exact occurrences are counted as ambiguous → throws", () => {
	// "aa" occurs at positions 0 AND 1 of "aaa"; picking either silently would
	// be a wrong-place edit. Overlap-aware counting must see 2 occurrences.
	assert.throws(
		() => applyEdits("aaa\n", [{ oldText: "aa", newText: "XY" }], "overlap.txt"),
		/not unique/i,
	);
});

test("fuzzy no-op (file already matches newText) → throws instead of silent write", () => {
	// oldText drifts (double space) so it fuzzy-matches the line, but newText
	// equals what the file already contains → stale context, fail loudly.
	const src = "alpha  beta\n";
	assert.throws(
		() => applyEdits(src, [{ oldText: "alpha beta", newText: "alpha  beta" }], "noop.txt"),
		/no changes|already matches/i,
	);
});

test("non-overlapping identical oldText given twice → throws", () => {
	assert.throws(
		() =>
			applyEdits(
				FILE,
				[
					{ oldText: "func layoutA() {", newText: "func layoutA(x int) {" },
					{ oldText: "func layoutA() {", newText: "func layoutA(y int) {" },
				],
				"tui.go",
			),
		/overlap|unique/i,
	);
});

test("two edits whose spans overlap → throws", () => {
	// outer span fully contains inner span.
	assert.throws(
		() =>
			applyEdits(
				"function f() {\n  return 1;\n}\n",
				[
					{ oldText: "function f() {\n  return 1;\n}", newText: "x" },
					{ oldText: "return 1;", newText: "return 2;" },
				],
				"f.js",
			),
		/overlap/i,
	);
});

test("unique oldText edits cleanly, returns line metadata", () => {
	const { content, edits } = applyEdits(
		FILE,
		[{ oldText: "func layoutA() {", newText: "func layoutA(ctx) {" }],
		"tui.go",
	);
	assert.equal(edits[0].matchedVia, "exact");
	assert.equal(edits[0].startLine, 3);
	assert.ok(content.includes("func layoutA(ctx) {"));
	assert.ok(content.includes("func layoutB() {")); // untouched
});
