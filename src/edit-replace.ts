// edit-replace.ts — strict, fault-tolerant multi-edit string replacement.
//
// Algorithmic concepts (line-trimmed / whitespace-normalized / escape-normalized
// fuzzy strategies, isDisproportionate heuristic) adapted from opencode's MIT
// edit.ts, which traces to cline (MIT) and gemini-cli (Apache-2.0). Re-implemented
// from scratch. See NOTICES.md.
//
// DESIGN PHILOSOPHY (reproduced independently from the maka-agent project, which
// is unlicensed and was NOT used as a code source):
//   1. Exact match first, no gating. Large files edit fine with an exact snippet.
//   2. Fuzzy matching is gated (min length, binary, size) and ONLY locates a span;
//      the replacement is written VERBATIM. Fuzzy never re-indents or rewrites.
//   3. Every fuzzy candidate must be a FULL-span structural match, must be the
//      single candidate, and must occur exactly once. Any ambiguity THROWS rather
//      than falling through to a looser strategy. "Better to fail loudly than to
//      silently edit the wrong place."
//   4. No partial-signal strategies (no first/last-line anchoring, no similarity
//      thresholds). Those are the documented cause of wrong-location edits in
//      upstream projects.

export type MatchStrategy = "exact" | "line-trimmed" | "whitespace" | "escape";

export interface EditRequest {
	oldText: string;
	newText: string;
}

export interface EditOutcome {
	/** Which strategy located oldText. */
	matchedVia: MatchStrategy;
	/** 1-based first line of the matched span in the original source. */
	startLine: number;
	/** 1-based last line (inclusive) of the matched span in the original source. */
	endLine: number;
}

export interface ApplyResult {
	content: string;
	edits: EditOutcome[];
}

// Fuzzy is O(n) per pass over the whole source; gate it to text-sized inputs.
const MIN_FUZZY_OLD_TEXT_LENGTH = 5;
const MAX_FUZZY_SOURCE_CHARS = 1_000_000;
const MAX_FUZZY_SOURCE_LINES = 50_000;

type Span = { start: number; end: number; via: MatchStrategy };

/**
 * Apply one or more disjoint edits to `source`. Each edit's `oldText` is matched
 * against the ORIGINAL source (not incrementally), so edits do not see each
 * other's effects. All matched spans must be pairwise non-overlapping.
 *
 * @throws when any oldText is missing, ambiguous (not unique), empty, identical
 *   to its newText, too short for a safe fuzzy match, on a binary/too-large file,
 *   or when two edits' spans overlap.
 */
export function applyEdits(source: string, edits: EditRequest[], where: string): ApplyResult {
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error(`edit: no edits provided for ${where}`);
	}

	// Resolve every edit's span against the original source first.
	const spans: Span[] = [];
	const outcomes: EditOutcome[] = new Array(edits.length);
	for (let i = 0; i < edits.length; i++) {
		const { oldText, newText } = edits[i];
		if (oldText === "") {
			throw new Error(`edit ${i + 1}: oldText must not be empty in ${where}`);
		}
		if (oldText === newText) {
			throw new Error(`edit ${i + 1}: no changes to apply in ${where} (oldText === newText)`);
		}
		const span = resolveSpan(source, oldText, `${where} (edit ${i + 1})`);
		spans.push({ ...span, via: span.via });
		outcomes[i] = {
			matchedVia: span.via,
			startLine: lineOf(source, span.start),
			endLine: lineOf(source, span.end - 1),
		};
	}

	// Reject overlapping edits (intervals are half-open [start, end)).
	for (let a = 0; a < spans.length; a++) {
		for (let b = a + 1; b < spans.length; b++) {
			const A = spans[a];
			const B = spans[b];
			if (A.start < B.end && B.start < A.end) {
				throw new Error(
					`edit: edits ${a + 1} and ${b + 1} overlap in ${where}; provide disjoint oldText blocks`,
				);
			}
		}
	}

	// Stitch: sort a copy by start position, slice the original, splice in newText.
	const order = spans.map((s, i) => ({ s, i })).sort((x, y) => x.s.start - y.s.start);
	let result = "";
	let cursor = 0;
	for (const { s, i } of order) {
		result += source.slice(cursor, s.start);
		result += toFileLineEndings(edits[i].newText, source);
		cursor = s.end;
	}
	result += source.slice(cursor);

	return { content: result, edits: outcomes };
}

/** Resolve a single oldText to a unique [start, end) span, exact then guarded fuzzy. */
function resolveSpan(source: string, oldText: string, where: string): { start: number; end: number; via: MatchStrategy } {
	// Exact match first — never gated.
	const exactCount = countOccurrences(source, oldText);
	if (exactCount === 1) {
		const idx = source.indexOf(oldText);
		return { start: idx, end: idx + oldText.length, via: "exact" };
	}
	if (exactCount > 1) {
		throw new Error(`oldText is not unique in ${where} (${exactCount} exact matches); provide more context`);
	}

	// Exact failed → fuzzy. Apply hard gates up front.
	if (oldText.trim().length < MIN_FUZZY_OLD_TEXT_LENGTH) {
		throw new Error(
			`oldText is too short for a non-exact match in ${where}; provide a longer, exact snippet`,
		);
	}
	if (source.indexOf("\0") !== -1) {
		throw new Error(`refusing a non-exact match in ${where}: file looks binary (contains a NUL byte); re-read and pass exact text`);
	}
	if (source.length > MAX_FUZZY_SOURCE_CHARS || countOccurrences(source, "\n") + 1 > MAX_FUZZY_SOURCE_LINES) {
		throw new Error(`refusing a non-exact match in ${where}: file is too large to fuzzy-match safely; re-read and pass exact text`);
	}

	const strategies: Array<{ via: MatchStrategy; find: (c: string, f: string) => string[] }> = [
		{ via: "line-trimmed", find: lineTrimmedSpans },
		{ via: "whitespace", find: whitespaceNormalizedSpans },
		{ via: "escape", find: escapeNormalizedSpans },
	];

	for (const { via, find } of strategies) {
		const candidates = dedupe(find(source, oldText).filter((c) => c.length > 0 && source.includes(c)));
		if (candidates.length === 0) continue; // this strategy found nothing → try the next
		if (candidates.length > 1) {
			throw new Error(`oldText matched ${candidates.length} different ${via} candidates in ${where}; provide more context to disambiguate`);
		}
		const span = candidates[0];
		// Must occur exactly once as a string too.
		if (source.indexOf(span) !== source.lastIndexOf(span)) {
			throw new Error(`oldText matched a ${via} span that occurs more than once in ${where}; provide more context to disambiguate`);
		}
		if (isDisproportionate(span, oldText)) {
			throw new Error(`refusing ${via} match in ${where}: the matched span is much larger than oldText; re-read and pass exact text`);
		}
		const idx = source.indexOf(span);
		return { start: idx, end: idx + span.length, via };
	}

	throw new Error(`oldText not found in ${where}; it must match the file's text including whitespace and indentation`);
}

// --- fuzzy strategies: each returns ORIGINAL substrings (never normalized) ---

/** Match line-by-line after trimming each line. Handles indentation/trailing-ws drift. */
function lineTrimmedSpans(content: string, find: string): string[] {
	const out: string[] = [];
	const lines = content.split("\n");
	const findEndsWithNewline = find.endsWith("\n");
	const search = find.split("\n");
	if (search.length > 0 && search[search.length - 1] === "") search.pop();
	if (search.length === 0) return out;

	for (let i = 0; i <= lines.length - search.length; i++) {
		let ok = true;
		for (let j = 0; j < search.length; j++) {
			if (lines[i + j].trim() !== search[j].trim()) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;

		let start = 0;
		for (let k = 0; k < i; k++) start += lines[k].length + 1;
		let end = start;
		for (let k = 0; k < search.length; k++) {
			end += lines[i + k].length;
			if (k < search.length - 1) end += 1;
		}
		// If oldText ended with a newline, the span must include the file's newline
		// after the last matched line, else the replacement would drop/duplicate it.
		// EOF with no such newline is not a faithful match → skip.
		if (findEndsWithNewline) {
			const lastLine = i + search.length - 1;
			if (lastLine >= lines.length - 1) continue;
			end += 1;
		}
		out.push(content.slice(start, end));
	}
	return out;
}

/** Match after collapsing all runs of whitespace to a single space. */
function whitespaceNormalizedSpans(content: string, find: string): string[] {
	const out: string[] = [];
	const norm = (t: string) => t.replace(/\s+/g, " ").trim();
	const want = norm(find);
	if (want === "") return out;
	const lines = content.split("\n");
	const findLines = find.split("\n");

	if (findLines.length === 1) {
		// Single-line oldText matches whole lines only. A multi-line oldText must
		// never collapse onto one physical line (would be a wrong-location edit).
		for (let i = 0; i < lines.length; i++) {
			if (norm(lines[i]) === want) out.push(lines[i]);
		}
	} else {
		for (let i = 0; i <= lines.length - findLines.length; i++) {
			const block = lines.slice(i, i + findLines.length).join("\n");
			if (norm(block) === want) out.push(block);
		}
	}
	return out;
}

/** Match after unescaping common escape sequences (\\n \\t \\\\ etc.). */
function escapeNormalizedSpans(content: string, find: string): string[] {
	const out: string[] = [];
	const unescape = (str: string) =>
		str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (m, ch: string) => {
			switch (ch) {
				case "n": return "\n";
				case "t": return "\t";
				case "r": return "\r";
				case "'": return "'";
				case '"': return '"';
				case "`": return "`";
				case "\\": return "\\";
				case "\n": return "\n";
				case "$": return "$";
				default: return m;
			}
		});
	const want = unescape(find);
	if (content.includes(want)) out.push(want);
	const lines = content.split("\n");
	const findLines = want.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		if (unescape(block) === want) out.push(block);
	}
	return out;
}

// --- helpers ---

/** Defense-in-depth guard. The curated strategies above all match a span whose
 * line count equals oldText's, so this rarely fires today — it exists to reject any
 * future partial-signal strategy (first/last-line anchoring) that could balloon a
 * span, which is the documented cause of wrong-location edits upstream. */
export function isDisproportionate(span: string, find: string): boolean {
	const oldLines = find.split("\n").length;
	const spanLines = span.split("\n").length;
	if (spanLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
	if (oldLines === 1) return false;
	return span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4);
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

function dedupe(arr: string[]): string[] {
	return [...new Set(arr)];
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === "\n") line++;
	}
	return line;
}

/**
 * If the source uses CRLF line endings, convert the replacement's LF to CRLF so
 * the edit does not flip the file's line-ending style. LF-only and mixed files
 * are left as-is (the replacement is written verbatim).
 */
function toFileLineEndings(text: string, source: string): string {
	const hasCRLF = source.includes("\r\n");
	const hasBareLF = source.includes("\n") && !hasCRLF;
	if (hasCRLF && !hasBareLF) {
		return text.replace(/\r?\n/g, "\r\n");
	}
	return text;
}
