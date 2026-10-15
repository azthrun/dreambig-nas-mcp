/**
 * Filesystem write helpers for tools.
 *
 * Atomic text write: content goes to a temp file in the target's folder, is
 * fsynced, then renamed over the target in one step, so readers never see a
 * half-written file and a crash never leaves the target missing: either the
 * old or the new version is there. The temp file is removed on failure; one
 * left by a crash is removed at the next startup (see temp-cleanup.ts).
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";

/** `mkdir -p` an absolute location; a file in the way becomes a not_a_folder error naming `rel`. */
export async function mkdirs(abs: string, rel: string): Promise<void> {
  try {
    await mkdir(abs, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw new ToolError("not_a_folder", `a parent of ${rel} is a file, not a folder`, [rel]);
    }
    throw err;
  }
}

/** Marker in temp file names: `.<target name>.nas-mcp-tmp-<12 hex>`. */
const TEMP_MARKER = ".nas-mcp-tmp-";
/** Matches a temp file name made by `atomicWriteText`. */
export const TEMP_FILE_NAME = /^\..*\.nas-mcp-tmp-[0-9a-f]{12}$/;

export interface AtomicWriteOptions {
  /**
   * Runs after the temp file is fully written and synced, just before it is
   * renamed over the target (e.g. put a copy of the old version in the Trash;
   * the target must stay in place). Throwing aborts the write, target untouched.
   */
  beforeRename?: () => Promise<void>;
}

export async function atomicWriteText(target: string, content: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}${TEMP_MARKER}${randomBytes(6).toString("hex")}`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await opts.beforeRename?.();
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
