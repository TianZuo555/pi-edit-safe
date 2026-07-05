# pi-edit-safe

A drop-in replacement for the **pi coding agent**'s built-in `edit` tool, with a
stricter matcher that refuses to silently edit the wrong place — and a call shape
that weaker models can actually use.

> Accepts pi's `edits[]` shape **plus** the shapes models emit anyway (top-level
> `oldText`/`newText`, Claude-Code/opencode field names, stringified arrays), so
> no model needs retraining. Multi-edit applies **in order** (sequential) — the
> contract models assume from multi-edit tools elsewhere — instead of pi's
> all-against-the-original-file semantic.

## Call shapes

```jsonc
// simplest — what weak models reach for first:
{ "path": "src/a.ts", "oldText": "const x = 1;", "newText": "const x = 2;" }

// several changes in one call, applied in order, top to bottom:
{ "path": "src/a.ts", "edits": [
	{ "oldText": "...", "newText": "..." },
	{ "oldText": "...", "newText": "..." }
] }
```

Also accepted and normalized before validation: `file_path`/`filePath` for `path`,
`old_string`/`new_string` and `oldString`/`newString` for the pair (per entry or
top-level), `edits` as a JSON **string**, and `edits` as a single object. Exact
duplicate entries are rejected loudly (weak models emit them; under sequential
application they could otherwise apply twice). When a later edit fails because an
earlier edit in the same call rewrote its target, the error says exactly that.

## Why

pi's edit tool and others (opencode, Claude Code) use exact + fuzzy search/replace.
The fuzzy layer is where things go wrong: opencode's `BlockAnchorReplacer` /
`ContextAwareReplacer` match on **partial signal** (first/last line + a similarity
threshold), and the orchestrator **falls through** (`continue`) on ambiguity until it
finds a "unique-looking" candidate — which is often the **wrong occurrence**.
Documented failures: opencode issues [#1261](https://github.com/sst/opencode/issues/1261),
[#2433](https://github.com/sst/opencode/issues/2433),
[#32559](https://github.com/sst/opencode/issues/32559), and pi's own
[#3554](https://github.com/earendil-works/pi/issues/3554) (whole-file Unicode normalization).

This tool takes the opposite stance on every one of those decisions:

| Decision | opencode | **pi-edit-safe** |
|---|---|---|
| Partial-signal strategies | BlockAnchor + ContextAware | **none** |
| On ambiguity | `continue` to next candidate | **throw immediately** |
| Fuzzy candidate validation | per-candidate uniqueness | **full-span structural equality + exactly-one + occurs-once** |
| Overlapping exact matches | caught (`indexOf !== lastIndexOf`) | **caught** (overlap-aware counting) |
| Unicode punctuation drift (“ ” — NBSP) | not handled | **strict `unicode` strategy** (pi's normalizer, span-only) |
| Untouched bytes | historically normalized | **never touched** (slice + verbatim splice) |
| Line endings | n/a (single-string replace) | **span-boundary only**; mixed-ending files never flattened (pi's built-in whole-file restore does) |
| new_string write | `String.replace` (`$&` bug) | **slice-join** (literal) |
| Multi-edit semantics | n/a (single edit per call) | **sequential, in order** (pi built-in: all edits vs the original file) |
| Input shapes | one strict schema | **lenient**: shorthand, alias keys, stringified arrays — normalized before validation |

## How it works

1. **Exact match first**, never gated. Large files edit fine with an exact snippet.
   Occurrences are counted overlap-aware ("aa" in "aaa" is ambiguous, not unique).
2. If exact fails, **hard gates** before any fuzzy work: min length 5, refuse binary
   (NUL byte), refuse files > 1M chars / 50k lines.
3. **Fuzzy cascade** (increasing tolerance): `line-trimmed → unicode-punctuation →
   whitespace-normalized → escape-normalized`. Each strategy returns **original**
   substrings (fuzzy only *locates*; it never rewrites).
4. For each strategy: if it yields **0** candidates, try the next; if it yields
   **>1**, **throw** (ambiguous — a looser strategy would only find more, never less);
   if exactly **1** that occurs exactly once and isn't disproportionate, use it.
5. `newText` written **verbatim** via slice-join (`$&`/`$1` stay literal). Line
   endings are converted only when the file is uniform (LF→CRLF in CRLF files,
   stray CRLF→LF in LF files); mixed-ending files take `newText` verbatim and
   untouched terminators are **never rewritten**. A fuzzy span never captures the
   trailing `\r` of a CRLF pair.
6. Multi-edit calls apply **sequentially, in order** — each `oldText` is matched
   against the file as already changed by the previous edits. Disjoint edits (the
   common case) produce byte-identical results to matching against the original;
   dependent edits work instead of erroring. Exact duplicates throw; a later edit
   broken by an earlier one gets an error that says so. A result byte-identical
   to the original also throws (stale-context signal, not a silent no-op write).

Every failure is a thrown error the model can read, re-read the file, and retry —
no silent recovery, no edits built on a stale lie.

## Install

```sh
# try it once, no install:
pi -e ./src/index.ts

# install as an extension:
pi install ./pi-edit-safe
```

Disable (fall back to built-in edit) without uninstalling:

```sh
PI_EDIT_SAFE_DISABLE=1 pi
```

## Try / test

```sh
npm install
npm test         # node:test + tsx
npm run bench     # A/B vs pi's real built-in edit (see below)
npm run typecheck
```

## A/B harness against the real built-in

`npm run bench` runs the same `(file, edits)` pairs through **pi's actual shipped
edit pipeline** (deep-imported from the installed `@earendil-works/pi-coding-agent`
dist — `stripBom → detectLineEnding → normalizeToLF → applyEditsToNormalizedContent
→ restoreLineEndings`, composed exactly as `dist/core/tools/edit.js` does) and through
pi-edit-safe, then byte-diffs them and checks untouched "canary" lines.

Current snapshot on pi 0.80.3 (12 cases): 8 agree, 4 diverge.

- **Agree**: exact unique, ambiguity (both throw not-unique), the #3554 corruption
  pattern (both preserve untouched bytes — **pi fixed it in 0.80.3**), binary refusal,
  overlap, CRLF exact, multi-edit disjoint, unicode punctuation drift (both recover it;
  bytes identical).
- **Diverge (safe recovers, built-in throws)**: collapsed-whitespace drift
  (`"x = a + b"` vs `"x =    a   +   b"`) and indent drift in a CRLF file — pi's fuzzy
  normalizer only strips *trailing* whitespace, so it misses both. pi-edit-safe
  recovers them via whitespace-normalized / line-trimmed fuzzy with full-span +
  exactly-one guards, and keeps every `\r\n` intact.
- **Diverge (built-in corrupts, safe preserves)**: a file with **mixed line endings**.
  The built-in normalizes the whole file to LF and then restores a single detected
  ending, silently flattening line 2's bare `\n` to `\r\n` (canary CORRUPTED in the
  bench). pi-edit-safe splices at the span boundary and never rewrites untouched
  terminators.
- **Diverge (sequential contract)**: dependent edits — edit 2's `oldText` targets
  edit 1's output. The built-in matches every edit against the original file and
  throws "not found"; pi-edit-safe applies them in order and both succeed.

Divergences are the whole point: they show exactly what behavior changes before you
trust it daily.

## Honesty

This is **"better by construction"**, not "proven better by benchmark". The guards
are validated via *opencode's* public bugs, not via cross-model evals (which pi
itself still lacks). If you hit a case where it fails badly, open an issue with the
session.

## Attribution

Algorithmic concepts (fuzzy strategies, disproportionate heuristic) adapted from
[opencode](https://github.com/sst/opencode) (MIT), which traces to
[cline](https://github.com/cline/cline) (MIT) and
[gemini-cli](https://github.com/google-gemini/gemini-cli) (Apache-2.0). Re-implemented
from scratch. The strict-ambiguity design philosophy mirrors the maka-agent project,
which is **unlicensed** and was **not** used as a code source — see
[NOTICES.md](./NOTICES.md).

## License

MIT © TianZuo555
