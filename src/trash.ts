/**
 * Trash (ADR-0001): replaced and removed entries are moved here instead of
 * being destroyed. It is a Hidden Entry at the top of the Root, named
 * `config.trashDirName`.
 *
 * Layout: `<Root>/<trashDirName>/<YYYY-MM-DD>/<original Root-relative Path>`,
 * where the date is the day the entry was trashed (server local time).
 */
import { lstat, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

/** An entry to trash: its Root-relative Path and its absolute location. */
export interface TrashSource {
  path: string;
  abs: string;
}

export class Trash {
  /** Absolute path of the Trash folder. */
  readonly dir: string;

  constructor(config: Config) {
    this.dir = path.join(config.root, config.trashDirName);
  }

  /**
   * Move an entry (file, folder, or symlink itself) into today's Trash folder,
   * keeping its Root-relative layout. Returns the Trash-relative Path it landed at.
   */
  async moveToTrash(entry: TrashSource, now: Date = new Date()): Promise<string> {
    const segs = [dateFolder(now), ...entry.path.split("/")];
    const placed: string[] = [];
    // Parent folders: reuse an existing folder, otherwise pick a name that is free or a folder.
    for (const seg of segs.slice(0, -1)) {
      placed.push(await this.pickName(placed, seg, true));
    }
    await mkdir(path.join(this.dir, ...placed), { recursive: true });
    placed.push(await this.pickName(placed, segs[segs.length - 1], false));
    await rename(entry.abs, path.join(this.dir, ...placed));
    return placed.join("/");
  }

  /**
   * First of `name`, `name (2)`, `name (3)`, ... (suffix before the extension
   * for files) inside `parent` that is free, or (if `folderOk`) an existing folder.
   */
  private async pickName(parent: string[], name: string, folderOk: boolean): Promise<string> {
    const ext = folderOk ? "" : path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      const st = await lstat(path.join(this.dir, ...parent, candidate)).catch(() => null);
      if (!st || (folderOk && st.isDirectory())) return candidate;
    }
  }
}

function dateFolder(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
