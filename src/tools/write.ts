import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteText, mkdirs } from "../atomic-write.js";
import { auditOk } from "../audit.js";
import { ToolError } from "../errors.js";
import { defineTool, structured } from "./types.js";

export const writeTool = defineTool({
  name: "write",
  title: "Write text file",
  description:
    "Create a UTF-8 text file inside the Root; missing parent folders are created. Fails if the file exists " +
    "unless `overwrite: true`, in which case the previous version is moved to the Trash (recoverable by the NAS owner).",
  inputSchema: {
    path: z.string().describe('Root-relative Path of the file, e.g. "notes/plan.md"'),
    content: z.string().describe("Full text content (UTF-8)"),
    overwrite: z.boolean().optional().describe("Replace an existing file (old version goes to Trash). Default false."),
  },
  outputSchema: {
    path: z.string(),
    size: z.number().describe("Bytes written"),
    replaced: z.boolean().describe("True if an existing file was replaced (its old version is in the Trash)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async handler({ path: input, content, overwrite }, { sandbox, trash }) {
    const target = await sandbox.resolveForCreate(input);
    // target.real follows symlinks, so writing through an in-Root symlink replaces its target file.
    const existing = await lstat(target.real).catch(() => null);
    if (existing) {
      if (!existing.isFile()) throw new ToolError("not_a_file", `${target.path} is not a file`, [target.path]);
      if (!overwrite) {
        throw new ToolError("exists", `${target.path} already exists; pass overwrite: true to replace it`, [target.path]);
      }
    }
    await mkdirs(path.dirname(target.real), target.path);
    let trashedAt: string | undefined;
    await atomicWriteText(target.real, content, {
      beforeRename: async () => {
        await sandbox.recheck(target.real, target.path);
        if (existing) trashedAt = await trash.copyToTrash(target);
      },
    });
    auditOk("write", [target.path], trashedAt ? [trashedAt] : undefined);
    return structured({ path: target.path, size: Buffer.byteLength(content), replaced: !!existing });
  },
});
