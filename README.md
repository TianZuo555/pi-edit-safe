# pi-edit-safe

A drop-in replacement for the **pi coding agent**'s built-in `edit` tool, with a
stricter matcher that refuses to silently edit the wrong place.

> Keeps pi's `edits[]` contract (multiple disjoint edits, each matched against the
> original file) so the model needs **no retraining** — just swap the tool.

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
| Untouched bytes | historically normalized | **never touched** (slice + verbatim splice) |
| new_string write | `String.replace` (`$&` bug) | **slice-join** (literal) |

## How it works

1. **Exact match first**, never gated. Large files edit fine with an exact snippet.
2. If exact fails, **hard gates** before any fuzzy work: min length 5, refuse binary
   (NUL byte), refuse files > 1M chars / 50k lines.
3. **Fuzzy cascade** (increasing tolerance): `line-trimmed → whitespace-normalized →
   escape-normalized`. Each strategy returns **original** substrings (fuzzy only
   *locates*; it never rewrites).
4. For each strategy: if it yields **0** candidates, try the next; if it yields
   **>1**, **throw** (ambiguous — a looser strategy would only find more, never less);
   if exactly **1** that occurs exactly once and isn't disproportionate, use it.
5. `newText` written **verbatim** via slice-join (`$&`/`$1` stay literal). CRLF files
   get `newText` line endings converted so the edit doesn't flip the file's style.
6. All edit spans resolved against the **original** file; pairwise overlap → throw.

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
npm run typecheck
```

The suite encodes every known failure mode as a regression: ambiguity (the tui.go
case), whole-file corruption (#3554), fuzzy drift, binary files, overlap, and the
disproportionate guard.

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
