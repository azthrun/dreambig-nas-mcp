/**
 * Trash (ADR-0001): replaced and removed entries are moved here instead of
 * being destroyed. It is a Hidden Entry at the top of the Root, named
 * `config.trashDirName`.
 *
 * Layout: `<Root>/<trashDirName>/<YYYY-MM-DD>/<original Root-relative Path>`,
 * where the date is the day the entry was trashed (server local time).
 *
 * Placement never replaces anything already in the Trash: every placement uses
 * a primitive that fails with EEXIST instead of overwriting (hard link, exclusive
 * mkdir, symlink), and on EEXIST the next free name is tried. Callers also hold
 * the write lock, which covers the one fallback without such a primitive.
 */
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { Located, Resolved } from "./sandbox.js";

/** What gets placed: Trash layout Path (Root-relative) and absolute location. */
interface TrashSource {
  path: string;
  abs: string;
}

const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;

/** Hard links are unsupported here (other filesystem, or a filesystem without them). */
const NO_LINK = new Set(["EXDEV", "EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP", "EMLINK"]);

/** Absolute path of the Trash folder. The one place the Trash location is defined. */
export const trashDir = (config: Config): string => path.join(config.root, config.trashDirName);

export class Trash {
  /** Absolute path of the Trash folder. */
  readonly dir: string;
  private readonly root: string;

  constructor(config: Config) {
    this.dir = trashDir(config);
    this.root = config.root;
  }

  /**
   * Move an entry as itself (file, folder, or the symlink itself; from
   * `Sandbox.resolveEntry` / `locateForCreate`) into today's Trash folder, keeping
   * its Root-relative layout. Returns the Trash-relative Path it landed at.
   */
  moveToTrash(entry: Located, now: Date = new Date()): Promise<string> {
    const src = { path: entry.selfPath, abs: entry.selfAbs };
    return this.place(src, now, (dest) => moveNoReplace(src.abs, dest));
  }

  /**
   * Put a copy of a file (its real location: symlinks followed, as from
   * `Sandbox.resolve`) into today's Trash folder and leave the original in
   * place (a hard link where possible, so no data is copied). Used before an
   * atomic replace, so the target is never missing. Returns the Trash-relative Path.
   */
  copyToTrash(file: Resolved, now: Date = new Date()): Promise<string> {
    const src = { path: path.relative(this.root, file.real).split(path.sep).join("/"), abs: file.real };
    return this.place(src, now, (dest) => copyNoReplace(src.abs, dest));
  }

  /**
   * Create the dated parent folders, then try `put(dest)` with `name`, `name (2)`,
   * ... (suffix before the extension) until it succeeds; `put` returns false if
   * `dest` already exists.
   */
  private async place(entry: TrashSource, now: Date, put: (dest: string) => Promise<boolean>): Promise<string> {
    const segs = [dateFolder(now), ...entry.path.split("/")];
    const placed: string[] = [];
    for (const seg of segs.slice(0, -1)) placed.push(await this.folder(placed, seg));
    const name = segs[segs.length - 1];
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      if (await put(path.join(this.dir, ...placed, candidate))) return [...placed, candidate].join("/");
    }
  }

  /** First of `name`, `name (2)`, ... inside `parent` that is (or could be created as) a folder. */
  private async folder(parent: string[], name: string): Promise<string> {
    await mkdir(path.join(this.dir, ...parent), { recursive: true });
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${name} (${n})`;
      const abs = path.join(this.dir, ...parent, candidate);
      try {
        await mkdir(abs);
        return candidate;
      } catch (err) {
        if (errnoCode(err) !== "EEXIST") throw err;
        if ((await lstat(abs)).isDirectory()) return candidate;
      }
    }
  }
}

/** Move `src` to `dest` without ever replacing `dest`. Returns false if `dest` exists. */
async function moveNoReplace(src: string, dest: string): Promise<boolean> {
  const st = await lstat(src);
  try {
    if (st.isDirectory()) {
      // Reserve the name with an exclusive mkdir, then rename over our own empty
      // reservation (POSIX rename replaces an empty folder; a non-empty one fails).
      await mkdir(dest);
      try {
        await rename(src, dest);
      } catch (err) {
        await rmdir(dest).catch(() => {});
        throw err;
      }
    } else if (st.isSymbolicLink()) {
      await symlink(await readlink(src), dest);
      await unlink(src);
    } else {
      try {
        await link(src, dest);
      } catch (err) {
        if (!NO_LINK.has(errnoCode(err) ?? "")) throw err;
        // No hard links here: check-then-rename, protected only by the write lock.
        if (await lstat(dest).then(() => true, () => false)) return false;
        await rename(src, dest);
        return true;
      }
      await unlink(src);
    }
    return true;
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
}

/** Hard-link (or, where unsupported, copy) the file `src` to `dest` without replacing `dest`. False if `dest` exists. */
async function copyNoReplace(src: string, dest: string): Promise<boolean> {
  try {
    try {
      await link(src, dest);
    } catch (err) {
      if (!NO_LINK.has(errnoCode(err) ?? "")) throw err;
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    }
    return true;
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
}

function dateFolder(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
