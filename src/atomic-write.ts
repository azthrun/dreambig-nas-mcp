/**
 * Filesystem write helpers for tools.
 *
 * Atomic text write: content goes to a temp file in the target's folder, then
 * is renamed over the target, so readers never see a half-written file. The
 * temp file is removed on failure.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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

export interface AtomicWriteOptions {
  /** Runs after the temp file is fully written, just before it is renamed into place (e.g. move the old version to Trash). */
  beforeRename?: () => Promise<void>;
}

export async function atomicWriteText(target: string, content: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.nas-mcp-tmp-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    await opts.beforeRename?.();
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
