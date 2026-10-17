/**
 * Root sandbox: the only module that turns agent-supplied Paths into filesystem
 * locations. Owns absolute-path / `..` rejection, symlink resolution + escape
 * checks, Hidden Entry matching, and Mount rules (ADR-0003). Tools must go through it.
 *
 * - `resolve(path)`        an existing entry (follows symlinks, must stay in a Mount)
 * - `resolveForChange(path)` same, for an entry about to be changed in place (edit)
 * - `resolveEntry(path)`   an existing entry as itself (move/delete source; symlink = the link)
 * - `resolveForCreate(path)` an entry that may not exist yet (for write/mkdir targets)
 * - `locateForCreate(path)` same, located as itself (move target)
 * - `children(dir)`        visible children of a folder (Hidden Entries and
 *                          out-of-Mount / broken symlinks are skipped)
 * - `isHidden(path)`       Hidden Entry check on a normalized Root-relative Path
 * - `mountOf(path)`        the Mount a real Root-relative Path is in
 *
 * Everything that changes the Root (`resolveForChange`, `resolveEntry`,
 * `resolveForCreate`, `locateForCreate`) refuses the top level (the Root itself
 * and the Mounts) and read-only Mounts, judged by the real location.
 */
import type { Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Config, Mount } from "./config.js";
import { ToolError } from "./errors.js";
import { fold, hiddenMatcher } from "./hidden.js";

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

/**
 * An entry located as itself: the last segment is not followed, so a symlink is
 * the link, not its target. Used for whatever gets renamed, replaced or trashed.
 */
export interface Located extends Resolved {
  /** Absolute location of the entry itself: real parent folder + entry name. */
  selfAbs: string;
  /** Root-relative Path of `selfAbs` (real parent's Path + entry name). */
  selfPath: string;
}

export interface Child extends Resolved {
  name: string;
  /** Stats of the target (symlinks followed). */
  stats: Stats;
  isSymlink: boolean;
  /** Set on a read-only Mount (children of the Root only). */
  readOnly?: true;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

export class Sandbox {
  readonly root: string;
  /** Folded (see `fold`) Trash folder name. */
  private readonly trashName: string;
  private readonly hiddenByName: (rel: string) => boolean;
  private readonly mounts: Map<string, Mount>;

  constructor(config: Config) {
    this.root = config.root;
    this.trashName = fold(config.trashDirName);
    this.hiddenByName = hiddenMatcher(config.extraHiddenPatterns);
    this.mounts = new Map(config.mounts.map((m) => [m.name, m]));
  }

  /** The Mount a real Root-relative Path is in (its first segment), if any. */
  mountOf(realRel: string): Mount | undefined {
    return this.mounts.get(realRel.split("/")[0]);
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

  /**
   * True if the normalized Root-relative Path is, or is inside, a Hidden Entry.
   * Matching is case-insensitive and after Unicode NFC normalisation.
   */
  isHidden(rel: string): boolean {
    if (this.hiddenByName(rel)) return true;
    // The Trash sits at the top of each Mount: `<mount>/<trash>/...`.
    const segs = rel.split("/");
    return segs.length >= 2 && fold(segs[1]) === this.trashName;
  }

  /** Root-relative Path of a real absolute location, or null if it is outside the Root. */
  private relInsideRoot(real: string): string | null {
    if (real === this.root) return "";
    if (!real.startsWith(this.root + path.sep)) return null;
    return real.slice(this.root.length + 1).split(path.sep).join("/");
  }

  /** Check a real location is the Root or inside a Mount, and not a Hidden Entry; returns its Root-relative Path. */
  private checkReal(real: string, rel: string): string {
    const realRel = this.relInsideRoot(real);
    if (realRel === null) throw new ToolError("forbidden", `${rel} resolves outside the Root`, [rel]);
    if (realRel !== "" && !this.mountOf(realRel)) {
      throw new ToolError("forbidden", `${rel} is not inside a Mount; Paths start with a Mount: ${this.mountNames()}`, [rel]);
    }
    if (this.isHidden(realRel)) throw new ToolError("forbidden", `${rel} is a Hidden Entry`, [rel]);
    return realRel;
  }

  private mountNames(): string {
    return [...this.mounts.keys()].join(", ");
  }

  /** Refuse changing a real Root-relative Path: the top level (Root, Mounts) or anything in a read-only Mount. */
  private checkWritable(realRel: string, rel: string): void {
    if (!realRel.includes("/")) {
      throw new ToolError(
        "forbidden",
        realRel === ""
          ? "the Root itself cannot be changed"
          : `${rel} is a Mount: Mounts cannot be created, renamed, replaced or deleted; work inside one (${this.mountNames()})`,
        [rel],
      );
    }
    const mount = this.mountOf(realRel)!;
    if (mount.readOnly) throw new ToolError("forbidden", `${rel} is in the read-only Mount ${mount.name}`, [rel]);
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

  /** Resolve an existing entry that is about to be changed in place (edit). Refuses the top level and read-only Mounts. */
  async resolveForChange(input: string): Promise<Resolved> {
    const resolved = await this.resolve(input);
    this.checkWritable(this.relInsideRoot(resolved.real)!, resolved.path);
    return resolved;
  }

  /**
   * Resolve an existing entry to be moved or trashed as itself (move/delete source).
   * Like `resolve`, but also locates the entry through its real parent folder without
   * following the entry itself, so a symlink is handled as the link, not its target.
   * Refuses the Root itself.
   */
  async resolveEntry(input: string): Promise<Located> {
    const resolved = await this.resolve(input);
    if (resolved.path === "") throw new ToolError("forbidden", "the Root itself cannot be moved or deleted", [""]);
    const selfAbs = path.join(await realpath(path.dirname(resolved.abs)), path.basename(resolved.abs));
    const selfPath = this.checkReal(selfAbs, resolved.path);
    this.checkWritable(selfPath, resolved.path);
    return { ...resolved, selfAbs, selfPath };
  }

  /**
   * Like `resolveForCreate`, but also locates the entry itself (move target): an
   * existing symlink there is to be replaced, not written through. The parent
   * folder may not exist yet.
   */
  async locateForCreate(input: string): Promise<Located> {
    const resolved = await this.locate(input);
    const parent = path.posix.dirname(resolved.path);
    const parentReal = parent === "." ? this.root : (await this.locate(parent)).real;
    const selfAbs = path.join(parentReal, path.basename(resolved.abs));
    const selfPath = this.checkReal(selfAbs, resolved.path);
    this.checkWritable(selfPath, resolved.path);
    return { ...resolved, selfAbs, selfPath };
  }

  /**
   * Resolve a Path that may not exist yet (write/mkdir/move target). The nearest
   * existing ancestor must resolve inside the Root, and the final real location
   * (that ancestor's real path + the remaining segments) must not be a Hidden
   * Entry. If the entry itself exists it is resolved like `resolve`. Throws
   * forbidden for the top level and read-only Mounts.
   */
  async resolveForCreate(input: string): Promise<Resolved> {
    const resolved = await this.locate(input);
    this.checkWritable(this.relInsideRoot(resolved.real)!, resolved.path);
    return resolved;
  }

  /** `resolveForCreate` without the writable check (also used for a move target's parent, which may be a Mount). */
  private async locate(input: string): Promise<Resolved> {
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
      // Check the final real location (real ancestor + remaining segments), not just the
      // ancestor: through a symlink to the Root, `r/.nas-mcp-trash/x` is really in the Trash.
      const finalReal = path.join(real, ...segs.slice(i));
      this.checkReal(finalReal, rel);
      return { path: rel, abs, real: finalReal };
    }
    throw new ToolError("not_found", "Root is missing", [rel]);
  }

  /**
   * Re-verify, right before a rename/replace, that the real parent folder of an
   * absolute location from `resolve*` is still that real folder (no symlink was
   * swapped into the chain since it was resolved). Cheap: one realpath call.
   * Only narrows the window for changes made outside this server; see write-lock.ts.
   */
  async recheck(abs: string, rel: string): Promise<void> {
    const dir = path.dirname(abs);
    const real = await realpath(dir).catch(() => null);
    if (real !== dir) {
      throw new ToolError("forbidden", `a parent folder of ${rel} changed during the operation; try again`, [rel]);
    }
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
    const atRoot = dir.real === this.root;
    for (const d of dirents) {
      const rel = dir.path ? `${dir.path}/${d.name}` : d.name;
      if (this.isHidden(rel)) continue;
      if (atRoot && !this.mounts.has(d.name)) continue; // appeared after startup: not a Mount
      const abs = path.join(dir.abs, d.name);
      const inReal = path.join(dir.real, d.name);
      try {
        const isSymlink = d.isSymbolicLink();
        const real = isSymlink ? await realpath(inReal) : inReal;
        const realRel = this.relInsideRoot(real);
        // Escapes the Root, is outside every Mount (a folder that appeared at the top after startup), or is a Hidden Entry.
        if (realRel === null || (realRel !== "" && !this.mountOf(realRel)) || this.isHidden(realRel)) continue;
        const stats = await (isSymlink ? stat : lstat)(real);
        const readOnly = atRoot && this.mounts.get(d.name)!.readOnly ? { readOnly: true as const } : {};
        out.push({ path: rel, name: d.name, abs, real, stats, isSymlink, ...readOnly });
      } catch {
        // Broken symlink or entry vanished meanwhile: skip.
      }
    }
    return out;
  }
}
