import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteText } from "../atomic-write.js";
import { audit } from "../audit.js";
import { detectKindFromBytes } from "../content-kind.js";
import { ToolError } from "../errors.js";
import { defineTool, structured } from "./types.js";

/** Largest file `edit` will load (matches the spec's default text read limit). */
const MAX_EDIT_BYTES = 10 * 1024 * 1024;

export const editTool = defineTool({
  name: "edit",
  title: "Edit text file",
  description:
    "Replace an exact string in a UTF-8 text file inside the Root. Fails if `oldString` is not found, or is found " +
    "more than once unless `replaceAll: true`. The pre-edit version is moved to the Trash (recoverable by the NAS owner).",
  inputSchema: {
    path: z.string().describe('Root-relative Path of the file, e.g. "notes/plan.md"'),
    oldString: z.string().describe("Exact text to replace (whitespace and line breaks must match)"),
    newString: z.string().describe("Replacement text"),
    replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match. Default false."),
  },
  outputSchema: {
    path: z.string(),
    replacements: z.number().describe("Number of occurrences replaced"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async handler({ path: input, oldString, newString, replaceAll }, { sandbox, trash }) {
    const entry = await sandbox.resolve(input);
    const st = await stat(entry.real);
    if (!st.isFile()) throw new ToolError("not_a_file", `${entry.path} is not a file`, [entry.path]);
    if (st.size > MAX_EDIT_BYTES) {
      throw new ToolError("too_large", `${entry.path} is ${st.size} bytes; edit is limited to ${MAX_EDIT_BYTES}`, [entry.path]);
    }
    const bytes = await readFile(entry.real);
    if (detectKindFromBytes(bytes, false).kind !== "text") {
      throw new ToolError("not_text", `${entry.path} is not a UTF-8 text file`, [entry.path]);
    }
    if (oldString === "") throw new ToolError("invalid", "oldString must not be empty", [entry.path]);
    if (oldString === newString) throw new ToolError("invalid", "oldString and newString are identical", [entry.path]);

    const text = bytes.toString("utf8");
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new ToolError("no_match", `oldString was not found in ${entry.path}`, [entry.path]);
    if (count > 1 && !replaceAll) {
      throw new ToolError(
        "not_unique",
        `oldString occurs ${count} times in ${entry.path}; add surrounding context to make it unique, or pass replaceAll: true`,
        [entry.path],
      );
    }
    const updated = text.split(oldString).join(newString);

    let trashedAt = "";
    await atomicWriteText(entry.real, updated, {
      beforeRename: async () => {
        trashedAt = await trash.moveToTrash({ path: sandbox.relativePath(entry.real), abs: entry.real });
      },
    });
    audit({ result: "ok", tool: "edit", paths: [entry.path], trashed: [trashedAt] });
    return structured({ path: entry.path, replacements: count });
  },
});
