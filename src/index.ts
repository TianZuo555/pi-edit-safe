// pi extension: override the built-in `edit` tool with a stricter, maka-philosophy
// matcher and a weak-model-friendly call shape. Accepts pi's edits[] form plus
// simpler shorthands (top-level oldText/newText, common alias field names,
// stringified arrays); multi-edit applies IN ORDER (sequential), the contract
// models assume from multi-edit tools elsewhere.
//
// Quick try:   pi -e ./src/index.ts
// Install:     pi install ./pi-edit-safe   (or copy to ~/.pi/agent/extensions/)
// Disable:     PI_EDIT_SAFE_DISABLE=1 pi   (falls back to the built-in edit)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { applyEdits } from "./edit-replace.js";
import { prepareEditArguments } from "./prepare-arguments.js";

const parameters = Type.Object({
	path: Type.String({
		description: "Path to the file to edit (relative or absolute).",
	}),
	oldText: Type.Optional(
		Type.String({
			description:
				"For a single replacement: the exact text to find. Must appear exactly once in the file.",
		}),
	),
	newText: Type.Optional(
		Type.String({
			description: "For a single replacement: the text that replaces oldText, written verbatim.",
		}),
	),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.String({
					description: "Exact text to find. Must be unique at the time this edit applies.",
				}),
				newText: Type.String({
					description: "Replacement text, written verbatim.",
				}),
			}),
			{
				description:
					"For several replacements in one call: applied in order, first to last. Each oldText is matched against the file as already changed by the previous edits in this call.",
			},
		),
	),
});

export default function editSafeExtension(pi: ExtensionAPI): void {
	// Kill switch: if set, do not register and let the built-in edit remain active.
	if (process.env.PI_EDIT_SAFE_DISABLE === "1") return;

	pi.registerTool({
		name: "edit", // same name as the built-in → overrides it
		label: "edit (strict)",
		description:
			"Replace text in a file. For one change, pass path, oldText, and newText. For several changes in one call, pass path and edits: [{oldText, newText}, ...] — they apply in order, one after another, each matched against the already-updated text. oldText must match the file and be unique; small whitespace/indentation, unicode-punctuation, or escape drift is tolerated only when the match is unambiguous. newText is written verbatim. On failure the error explains why so you can re-read the file and retry.",
		parameters,
		// Normalize lenient input shapes (alias keys, stringified arrays,
		// single-object edits, top-level shorthand) before schema validation.
		prepareArguments: (args: unknown) => prepareEditArguments(args) as Static<typeof parameters>,
		promptGuidelines: [
			"Prefer `edit` for targeted changes and `write` only for new files or full rewrites.",
			"For a single change pass oldText/newText directly; use edits[] only for several changes in one call. Edits apply in order, top to bottom.",
			"Each oldText must be unique in the file; include surrounding lines to disambiguate when needed.",
			"On an edit failure, re-read the file before retrying — the error usually means your context was stale or the match was ambiguous.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Re-normalize defensively: the prepareArguments hook already ran on
			// current pi versions, and normalization is idempotent.
			const { path, edits } = prepareEditArguments(params);
			if (!path) {
				throw new Error(`edit: missing "path" — pass the file to edit`);
			}
			const abs = resolve(ctx.cwd, path);

			// Read, match, and write all inside the mutation queue so no other
			// pi-side mutation can interleave between our read and our write.
			return withFileMutationQueue(abs, async () => {
				const throwIfAborted = () => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();

				let source: string;
				try {
					source = await readFile(abs, "utf-8");
				} catch (err) {
					throw new Error(`edit: cannot read "${path}" (${(err as NodeJS.ErrnoException).message}). Use the write tool to create a new file.`);
				}
				throwIfAborted();

				const { content, edits: outcomes } = applyEdits(source, edits, path);
				await writeFile(abs, content, "utf-8");

				const summary = outcomes
					.map((o, i) => `  ${i + 1}. ${o.matchedVia} match → lines ${o.startLine}-${o.endLine}`)
					.join("\n");

				return {
					content: [
						{
							type: "text",
							text: `Edited ${path} (${outcomes.length} replacement${outcomes.length > 1 ? "s, applied in order" : ""}):\n${summary}`,
						},
					],
					details: { path: abs, edits: outcomes },
				};
			});
		},
	});
}
