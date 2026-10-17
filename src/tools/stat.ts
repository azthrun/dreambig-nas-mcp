import { stat } from "node:fs/promises";
import { z } from "zod";
import { detectKind } from "../content-kind.js";
import { entryType } from "../sandbox.js";
import { defineTool, structured } from "./types.js";

export const statTool = defineTool({
  name: "stat",
  title: "File info",
  description:
    "Get info about a file or folder inside the Root: type, size, modified/created time, and for files the " +
    "detected content kind (text, pdf, image, binary). Use before `read` to check what a file is.",
  inputSchema: {
    path: z.string().describe('Root-relative Path, e.g. "docs/notes/plan.md"'),
  },
  outputSchema: {
    path: z.string(),
    type: z.enum(["file", "folder", "other"]),
    size: z.number().describe("Bytes (0 for folders)"),
    modified: z.string().describe("ISO 8601"),
    created: z.string().optional().describe("ISO 8601, if the filesystem records it"),
    contentKind: z.enum(["text", "pdf", "image", "binary"]).optional().describe("Files only"),
    mimeType: z.string().optional(),
    readOnly: z.boolean().optional().describe("True on a read-only Mount: nothing inside it can be changed"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ path }, { sandbox }) {
    const entry = await sandbox.resolve(path);
    const mount = entry.path.includes("/") ? undefined : sandbox.mountOf(entry.path);
    const st = await stat(entry.real);
    const kind = st.isFile() ? await detectKind(entry.real) : undefined;
    return structured({
      path: entry.path,
      type: entryType(st),
      size: st.isFile() ? st.size : 0,
      modified: st.mtime.toISOString(),
      ...(st.birthtimeMs > 0 ? { created: st.birthtime.toISOString() } : {}),
      ...(kind ? { contentKind: kind.kind, ...(kind.mimeType ? { mimeType: kind.mimeType } : {}) } : {}),
      ...(mount?.readOnly ? { readOnly: true } : {}),
    });
  },
});
