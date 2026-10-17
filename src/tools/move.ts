import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { mkdirs } from "../atomic-write.js";
import { auditOk } from "../audit.js";
import { ToolError } from "../errors.js";
import { defineTool, structured } from "./types.js";

export const moveTool = defineTool({
  name: "move",
  title: "Move or rename",
  description:
    "Move or rename a file or folder within one Mount; missing parent folders of the target are created. Moving " +
    "between Mounts is not supported (read, write and delete instead). Fails if " +
    "the target exists unless `overwrite: true`, in which case the replaced item is moved to the Trash " +
    "(recoverable by the NAS owner). A symlink is moved as the link itself.",
  inputSchema: {
    from: z.string().describe('Root-relative Path of the file or folder to move, e.g. "docs/notes/draft.md"'),
    to: z.string().describe('Root-relative Path it should have afterwards, e.g. "docs/archive/draft.md"'),
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
    // Located as itself: an existing symlink at the target is replaced, not written through.
    const target = await sandbox.locateForCreate(to);

    const [fromMount, toMount] = [source.selfPath, target.selfPath].map((p) => p.split("/")[0]);
    if (fromMount !== toMount) {
      throw new ToolError(
        "invalid",
        `cannot move ${source.path} to ${target.path}: they are in different Mounts (${fromMount}, ${toMount}); ` +
          "read, write and delete instead",
        [source.path, target.path],
      );
    }
    if (target.selfAbs === source.selfAbs) {
      throw new ToolError("invalid", `${source.path} and ${target.path} are the same entry`, [source.path, target.path]);
    }
    if (target.selfAbs.startsWith(source.selfAbs + path.sep)) {
      throw new ToolError("invalid", `cannot move ${source.path} into itself (${target.path})`, [source.path, target.path]);
    }
    const [srcStat, existing] = await Promise.all([lstat(source.selfAbs), lstat(target.selfAbs).catch(() => null)]);
    // Same inode under another name: a case-only rename on a case-insensitive filesystem.
    const sameEntry = !!existing && existing.ino === srcStat.ino && existing.dev === srcStat.dev;
    const replacing = !!existing && !sameEntry;
    if (replacing && !overwrite) {
      throw new ToolError("exists", `${target.path} already exists; pass overwrite: true to replace it`, [target.path]);
    }

    await mkdirs(path.dirname(target.selfAbs), target.path);
    await sandbox.recheck(source.selfAbs, source.path);
    await sandbox.recheck(target.selfAbs, target.path);
    const trashed = replacing ? [await trash.moveToTrash(target)] : undefined;
    await rename(source.selfAbs, target.selfAbs);
    auditOk("move", [source.path, target.path], trashed);
    return structured({ from: source.path, to: target.path, replaced: replacing });
  },
});
