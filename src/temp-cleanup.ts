/**
 * Startup cleanup of temp files left by an atomic write that was interrupted
 * (crash, container stop) between writing the temp file and renaming it into
 * place. Walks every writable Mount (read-only Mounts, Hidden Entries and
 * symlinks are not entered), removes
 * every file named like `atomicWriteText`'s temp files, and audits what it
 * removed. Runs under the write lock, so it never races a live write.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { TEMP_FILE_NAME } from "./atomic-write.js";
import { audit } from "./audit.js";
import type { Config } from "./config.js";
import { Sandbox } from "./sandbox.js";
import { withWriteLock } from "./write-lock.js";

/** Remove leftover temp files in the Root. Emits one audit line (`action: "temp_cleanup"`) if any were found. Never throws. */
export function cleanupTempFiles(config: Config): Promise<void> {
  return withWriteLock(async () => {
    const sandbox = new Sandbox(config);
    const removed: string[] = [];
    try {
      const walk = async (abs: string, rel: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(abs, { withFileTypes: true });
        } catch {
          return; // unreadable or vanished: nothing we could have written there
        }
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (sandbox.isHidden(childRel)) continue;
          const childAbs = path.join(abs, e.name);
          if (e.isDirectory()) await walk(childAbs, childRel);
          else if (e.isFile() && TEMP_FILE_NAME.test(e.name)) {
            await rm(childAbs, { force: true });
            removed.push(childRel);
          }
        }
      };
      for (const mount of config.mounts) if (!mount.readOnly) await walk(mount.abs, mount.name);
      if (removed.length) audit({ result: "ok", action: "temp_cleanup", removed });
    } catch (err) {
      audit({ result: "error", action: "temp_cleanup", removed, message: (err as Error).message });
    }
  });
}
