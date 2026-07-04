// Fuzzy strategies land correctly and write newText verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits } from "../src/edit-replace.ts";

test("line-trimmed: indentation drift is tolerated, span is the ORIGINAL lines", () => {
	const src = "function f() {\n    return 1;\n}\n";
	// oldText uses 2-space indent; file uses 4-space → exact fails, line-trimmed matches.
	const edit = { oldText: "function f() {\n  return 1;\n}", newText: "function f() {\n    return 2;\n}" };
	const { content, edits } = applyEdits(src, [edit], "f.js");
	assert.equal(edits[0].matchedVia, "line-trimmed");
	assert.equal(content, "function f() {\n    return 2;\n}\n");
});

test("whitespace-normalized: collapsed-ws drift tolerated", () => {
	const src = "const x =    a   +   b;\n";
	// oldText single-spaces everything; file has multiple spaces → whitespace strategy.
	const edit = { oldText: "const x = a + b;", newText: "const x = a - b;" };
	const { content, edits } = applyEdits(src, [edit], "x.js");
	assert.equal(edits[0].matchedVia, "whitespace");
	assert.equal(content, "const x = a - b;\n");
});

test("escape-normalized: literal \\n matches actual newline", () => {
	const src = "const msg = hello world;\n";
	// oldText writes a literal backslash-n where the file has a space; escape strategy
	// won't help here. Instead test: file has actual newline, oldText writes \\n.
	const multi = "line one\nline two\n";
	const edit = { oldText: "line one\\nline two", newText: "alpha\\nbeta" };
	const { content, edits } = applyEdits(multi, [edit], "esc.txt");
	assert.equal(edits[0].matchedVia, "escape");
	// newText written verbatim (literal backslash-n preserved).
	assert.equal(content, "alpha\\nbeta\n");
});

test("newText with $& regex special chars is written literally (no String.replace expansion)", () => {
	const src = "price = 100;\n";
	const edit = { oldText: "price = 100;", newText: "price = $& discount;" };
	const { content } = applyEdits(src, [edit], "p.js");
	// $& must remain literal, NOT expand to the matched text.
	assert.equal(content, "price = $& discount;\n");
});

test("CRLF source: newText line endings converted to match file", () => {
	const src = "const a = 1;\r\nconst b = 2;\r\n";
	const edit = { oldText: "const b = 2;", newText: "const b = 3;\nconst c = 4;" };
	const { content } = applyEdits(src, [edit], "crlf.js");
	// newText's LF should be normalized to CRLF.
	assert.equal(content, "const a = 1;\r\nconst b = 3;\r\nconst c = 4;\r\n");
});

test("too-short oldText with no exact match refuses fuzzy", () => {
	const src = "aaa bbb ccc\n";
	// "xy" is shorter than MIN_FUZZY (5) and not an exact match → throws.
	assert.throws(
		() => applyEdits(src, [{ oldText: "xy", newText: "q" }], "short.txt"),
		/too short/i,
	);
});
