import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { mkdirs } from "../atomic-write.js";
import { audit } from "../audit.js";
import { ToolError } from "../errors.js";
import { defineTool, structured } from "./types.js";

export const moveTool = defineTool({
  name: "move",
  title: "Move or rename",
  description:
    "Move or rename a file or folder inside the Root; missing parent folders of the target are created. Fails if " +
    "the target exists unless `overwrite: true`, in which case the replaced item is moved to the Trash " +
    "(recoverable by the NAS owner). A symlink is moved as the link itself.",
  inputSchema: {
    from: z.string().describe('Root-relative Path of the file or folder to move, e.g. "notes/draft.md"'),
    to: z.string().describe('Root-relative Path it should have afterwards, e.g. "archive/draft.md"'),
    overwrite: z.boolean().optional().describe("Replace an existing target (it goes to Trash). Default false."),
  },
  outputSchema: {
    from: z.string(),
    to: z.string(),
    replaced: z.boolean().describe("True if an existing target was replaced (it is in the Trash)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async handler({ from, to, overwrite }, { sandbox, trash }) {
    const source = await sandbox.resolveEntry(from);
    const target = await sandbox.resolveForCreate(to);
    // Locate the target as itself (an existing symlink there is replaced, not written through).
    const parent = path.dirname(target.path);
    const parentReal = parent === "." ? sandbox.root : (await sandbox.resolveForCreate(parent)).real;
    const targetAt = path.join(parentReal, path.basename(target.path));
    const targetAtPath = sandbox.relativePath(targetAt);

    if (targetAt === source.at) {
      throw new ToolError("invalid", `${source.path} and ${target.path} are the same entry`, [source.path, target.path]);
    }
    if (targetAt.startsWith(source.at + path.sep)) {
      throw new ToolError("invalid", `cannot move ${source.path} into itself (${target.path})`, [source.path, target.path]);
    }
    const [srcStat, existing] = await Promise.all([lstat(source.at), lstat(targetAt).catch(() => null)]);
    // Same inode under another name: a case-only rename on a case-insensitive filesystem.
    const sameEntry = !!existing && existing.ino === srcStat.ino && existing.dev === srcStat.dev;
    const replacing = !!existing && !sameEntry;
    if (replacing && !overwrite) {
      throw new ToolError("exists", `${target.path} already exists; pass overwrite: true to replace it`, [target.path]);
    }

    await mkdirs(path.dirname(targetAt), target.path);
    const trashed = replacing ? [await trash.moveToTrash({ path: targetAtPath, abs: targetAt })] : undefined;
    await sandbox.recheck(source.at, source.path);
    await sandbox.recheck(targetAt, target.path);
    await rename(source.at, targetAt);
    audit({ result: "ok", tool: "move", paths: [source.path, target.path], ...(trashed ? { trashed } : {}) });
    return structured({ from: source.path, to: target.path, replaced: replacing });
  },
});
