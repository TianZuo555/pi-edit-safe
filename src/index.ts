// pi extension: override the built-in `edit` tool with a stricter, maka-philosophy
// matcher. Keeps pi's `edits[]` contract (multiple disjoint edits, each matched
// against the original file) so the model needs no retraining.
//
// Quick try:   pi -e ./src/index.ts
// Install:     pi install ./pi-edit-safe   (or copy to ~/.pi/agent/extensions/)
// Disable:     PI_EDIT_SAFE_DISABLE=1 pi   (falls back to the built-in edit)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { applyEdits, type EditRequest } from "./edit-replace.js";

const parameters = Type.Object({
	path: Type.String({
		description: "Path to the file to edit (relative or absolute).",
	}),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description:
					"Exact text to find. Must be present and unique in the file. Trailing/leading whitespace and minor escape drift are tolerated, but only when the match is unambiguous.",
			}),
			newText: Type.String({
				description: "Replacement text, written verbatim. Provide the exact final formatting/indentation you want.",
			}),
		}),
		{
			description:
				"One or more disjoint edits. Every oldText is matched against the ORIGINAL file (not incrementally), so edits never see each other. All matched spans must be non-overlapping.",
		},
	),
});

export default function editSafeExtension(pi: ExtensionAPI): void {
	// Kill switch: if set, do not register and let the built-in edit remain active.
	if (process.env.PI_EDIT_SAFE_DISABLE === "1") return;

	pi.registerTool({
		name: "edit", // same name as the built-in → overrides it
		label: "edit (strict)",
		description:
			"Edit a file by replacing exact, unique text blocks. Prefers an exact unique match; if exact fails it tolerates limited whitespace/indentation/escape drift in oldText, but ONLY when the match is unambiguous — otherwise it errors so you can re-read and retry. newText is written verbatim. Supports multiple disjoint edits in one call; each oldText is matched against the original file. Errors if oldText is missing, not unique, empty, or overlaps another edit.",
		parameters,
		promptGuidelines: [
			"Prefer `edit` for targeted changes and `write` only for new files or full rewrites.",
			"Each `oldText` must be unique in the file; include surrounding lines to disambiguate when needed.",
			"On an edit failure, re-read the file before retrying — the error usually means your context was stale or the match was ambiguous.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { path, edits } = params as { path: string; edits: EditRequest[] };
			const abs = resolve(ctx.cwd, path);

			let source: string;
			try {
				source = await readFile(abs, "utf-8");
			} catch (err) {
				throw new Error(`edit: cannot read "${path}" (${(err as NodeJS.ErrnoException).message}). Use the write tool to create a new file.`);
			}

			const { content, edits: outcomes } = applyEdits(source, edits, path);

			await withFileMutationQueue(abs, async () => {
				// Re-read right before writing to narrow the race window; if another
				// process changed the file since our match, fail loudly.
				const current = await readFile(abs, "utf-8");
				if (current !== source) {
					throw new Error(`edit: "${path}" changed on disk after it was read; re-read and retry`);
				}
				const { writeFile } = await import("fs/promises");
				await writeFile(abs, content, "utf-8");
			});

			const summary = outcomes
				.map((o, i) => `  ${i + 1}. ${o.matchedVia} match → lines ${o.startLine}-${o.endLine}`)
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Edited ${path} (${outcomes.length} replacement${outcomes.length > 1 ? "s" : ""}):\n${summary}`,
					},
				],
				details: { path: abs, edits: outcomes },
			};
		},
	});
}
