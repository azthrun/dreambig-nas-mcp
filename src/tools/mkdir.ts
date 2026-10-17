import { lstat } from "node:fs/promises";
import { z } from "zod";
import { auditOk } from "../audit.js";
import { ToolError } from "../errors.js";
import { mkdirs } from "../atomic-write.js";
import { defineTool, structured } from "./types.js";

export const mkdirTool = defineTool({
  name: "mkdir",
  title: "Create folder",
  description:
    "Create a folder inside a Mount (not in a read-only one), including any missing parent folders. Succeeds without changes if the folder already exists.",
  inputSchema: {
    path: z.string().describe('Root-relative Path of the folder, e.g. "docs/projects/2026"'),
  },
  outputSchema: {
    path: z.string(),
    created: z.boolean().describe("False if the folder already existed"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler({ path: input }, { sandbox }) {
    const target = await sandbox.resolveForCreate(input);
    const existing = await lstat(target.real).catch(() => null);
    if (existing && !existing.isDirectory()) {
      throw new ToolError("exists", `${target.path} already exists and is not a folder`, [target.path]);
    }
    if (!existing) await mkdirs(target.real, target.path);
    auditOk("mkdir", [target.path]);
    return structured({ path: target.path, created: !existing });
  },
});
