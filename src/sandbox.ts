/**
 * Root sandbox: the only module that turns agent-supplied Paths into filesystem
 * locations. Owns absolute-path / `..` rejection, symlink resolution + escape
 * checks, and Hidden Entry matching. Tools must go through it.
 *
 * - `resolve(path)`        an existing entry (follows symlinks, must stay in Root)
 * - `resolveForCreate(path)` an entry that may not exist yet (for write/mkdir/move targets)
 * - `children(dir)`        visible children of a folder (Hidden Entries and
 *                          out-of-Root / broken symlinks are skipped)
 * - `isHidden(path)`       Hidden Entry check on a normalized Root-relative Path
 */
import type { Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { ToolError } from "./errors.js";

/** Synology system entries, hidden at any depth. */
export const DEFAULT_HIDDEN_NAMES = ["@eaDir", "#recycle", "#snapshot", ".DS_Store"];

/** Entry type as reported to agents (symlinks are reported as their target). */
export const entryType = (s: Stats): "file" | "folder" | "other" =>
  s.isFile() ? "file" : s.isDirectory() ? "folder" : "other";

export interface Resolved {
  /** Normalized Root-relative Path ("" for the Root itself). */
  path: string;
  /** Absolute location under the Root, symlinks not followed (use for create/rename). */
  abs: string;
  /** Absolute real location (symlinks followed). For not-yet-existing entries: real parent + name. */
  real: string;
}

export interface Child extends Resolved {
  name: string;
  /** Stats of the target (symlinks followed). */
  stats: Stats;
  isSymlink: boolean;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

export class Sandbox {
  readonly root: string;
  private readonly trashDirName: string;
  private readonly extraPatterns: string[];

  constructor(config: Config) {
    this.root = config.root;
    this.trashDirName = config.trashDirName;
    this.extraPatterns = config.extraHiddenPatterns;
  }

  /** Parse an agent-supplied Path into segments, rejecting absolute paths and `..`. */
  private segments(input: string): string[] {
    if (typeof input !== "string") throw new ToolError("invalid", "Path must be a string");
    if (input.includes("\0")) throw new ToolError("forbidden", "Path contains a NUL byte", [input]);
    if (input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:/.test(input)) {
      throw new ToolError("forbidden", `absolute paths are not allowed; use a Path relative to the Root: ${input}`, [input]);
    }
    const segs = input.split(/[/\\]/).filter((s) => s !== "" && s !== ".");
    if (segs.includes("..")) {
      throw new ToolError("forbidden", `".." is not allowed in a Path: ${input}`, [input]);
    }
    return segs;
  }

  /** True if the normalized Root-relative Path is, or is inside, a Hidden Entry. */
  isHidden(rel: string): boolean {
    if (rel === "") return false;
    const segs = rel.split("/");
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i];
      if (DEFAULT_HIDDEN_NAMES.includes(name)) return true;
      if (i === 0 && name === this.trashDirName) return true;
      const prefix = segs.slice(0, i + 1).join("/");
      for (const pattern of this.extraPatterns) {
        if (pattern.includes("/") ? path.matchesGlob(prefix, pattern) : path.matchesGlob(name, pattern)) return true;
      }
    }
    return false;
  }

  /** Root-relative Path of a real absolute location, or null if it is outside the Root. */
  private relInsideRoot(real: string): string | null {
    if (real === this.root) return "";
    if (!real.startsWith(this.root + path.sep)) return null;
    return real.slice(this.root.length + 1).split(path.sep).join("/");
  }

  /** Check a real location is inside the Root and not a Hidden Entry; returns its Root-relative Path. */
  private checkReal(real: string, rel: string): string {
    const realRel = this.relInsideRoot(real);
    if (realRel === null) throw new ToolError("forbidden", `${rel} resolves outside the Root`, [rel]);
    if (this.isHidden(realRel)) throw new ToolError("forbidden", `${rel} is a Hidden Entry`, [rel]);
    return realRel;
  }

  /** Resolve an existing entry. Throws not_found / forbidden. */
  async resolve(input: string): Promise<Resolved> {
    const segs = this.segments(input);
    const rel = segs.join("/");
    if (this.isHidden(rel)) throw new ToolError("forbidden", `${rel} is a Hidden Entry`, [rel]);
    const abs = path.join(this.root, ...segs);
    let real: string;
    try {
      real = await realpath(abs);
    } catch (err) {
      const code = errnoCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") throw new ToolError("not_found", `${rel || "/"} does not exist`, [rel]);
      if (code === "EACCES") throw new ToolError("forbidden", `permission denied: ${rel}`, [rel]);
      throw err;
    }
    this.checkReal(real, rel);
    return { path: rel, abs, real };
  }

  /**
   * Resolve a Path that may not exist yet (write/mkdir/move target). The nearest
   * existing ancestor must resolve inside the Root. If the entry itself exists it
   * is resolved like `resolve`. Throws forbidden for the Root itself.
   */
  async resolveForCreate(input: string): Promise<Resolved> {
    const segs = this.segments(input);
    const rel = segs.join("/");
    if (rel === "") throw new ToolError("forbidden", "the Root itself cannot be replaced", [rel]);
    if (this.isHidden(rel)) throw new ToolError("forbidden", `${rel} is a Hidden Entry`, [rel]);
    const abs = path.join(this.root, ...segs);
    // Walk up to the nearest existing ancestor (or the entry itself).
    for (let i = segs.length; i >= 0; i--) {
      const candidate = path.join(this.root, ...segs.slice(0, i));
      let real: string;
      try {
        real = await realpath(candidate);
      } catch (err) {
        const code = errnoCode(err);
        if (code === "ENOENT" || code === "ENOTDIR") {
          // A dangling symlink at this level must not be written through.
          const isLink = await lstat(candidate).then((s) => s.isSymbolicLink(), () => false);
          if (isLink) throw new ToolError("forbidden", `${segs.slice(0, i).join("/")} is a broken symlink`, [rel]);
          continue;
        }
        if (code === "EACCES") throw new ToolError("forbidden", `permission denied: ${rel}`, [rel]);
        throw err;
      }
      this.checkReal(real, rel);
      return { path: rel, abs, real: path.join(real, ...segs.slice(i)) };
    }
    throw new ToolError("not_found", "Root is missing", [rel]);
  }

  /** Visible children of a resolved folder, sorted by name. */
  async children(dir: Resolved): Promise<Child[]> {
    let dirents;
    try {
      dirents = await readdir(dir.real, { withFileTypes: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code === "ENOTDIR") throw new ToolError("not_a_folder", `${dir.path} is not a folder`, [dir.path]);
      if (code === "ENOENT") throw new ToolError("not_found", `${dir.path} does not exist`, [dir.path]);
      if (code === "EACCES") throw new ToolError("forbidden", `permission denied: ${dir.path}`, [dir.path]);
      throw err;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out: Child[] = [];
    for (const d of dirents) {
      const rel = dir.path ? `${dir.path}/${d.name}` : d.name;
      if (this.isHidden(rel)) continue;
      const abs = path.join(dir.abs, d.name);
      const inReal = path.join(dir.real, d.name);
      try {
        const isSymlink = d.isSymbolicLink();
        const real = isSymlink ? await realpath(inReal) : inReal;
        const realRel = this.relInsideRoot(real);
        if (realRel === null || this.isHidden(realRel)) continue; // escapes Root or is a Hidden Entry
        out.push({ path: rel, name: d.name, abs, real, stats: await (isSymlink ? stat : lstat)(real), isSymlink });
      } catch {
        // Broken symlink or entry vanished meanwhile: skip.
      }
    }
    return out;
  }
}
