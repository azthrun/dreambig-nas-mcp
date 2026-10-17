/**
 * Mounts (#18, ADR-0003): the Root is a virtual top level whose folders are the
 * Mounts, auto-discovered from the folders under NAS_MCP_ROOT. The top level is
 * read-only, each writable Mount has its own Trash, read-only Mounts refuse
 * every change, and nothing moves between Mounts.
 *
 * Read-only Mounts are made with chmod (a `:ro` bind mount needs root); the
 * server treats both causes the same way (`access(W_OK)` fails).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodTree, makeTempDir, runServerExpectingExit, startServer, TEST_TOKEN, textOf, type TestServer } from "./harness.js";
import { allEntries, TRASH_DIR, trashFiles } from "./trash-helpers.js";

const DAY = String.raw`\d{4}-\d{2}-\d{2}`;
const asRoot = process.getuid?.() === 0;

/** Trash date folder name for `n` days before today (local time, like the server). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe.concurrent("Mount discovery at startup", () => {
  const cleanup: string[] = [];
  afterAll(async () => {
    for (const dir of cleanup.splice(0)) {
      await chmodTree(dir);
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** A fresh Root with the given top-level folders (or files, if the name ends in "~"). */
  async function rootWith(...children: string[]): Promise<string> {
    const root = await makeTempDir();
    cleanup.push(root);
    for (const c of children) {
      if (c.endsWith("~")) await writeFile(path.join(root, c.slice(0, -1)), "x");
      else await mkdir(path.join(root, c));
    }
    return root;
  }

  const run = (root: string, env: Record<string, string> = {}) =>
    runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: TEST_TOKEN, NAS_MCP_REQUIRE_MOUNT_POINTS: "false", ...env });

  it("refuses a folder under the Root that is not a mount point (by default)", async () => {
    const root = await rootWith("docs");
    const { code, stderr } = await runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: TEST_TOKEN });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/docs/);
    expect(stderr).toMatch(/not a mount point/i);
  });

  it("points a v1 single-folder Root (Trash, #recycle, files at the top) to the migration", async () => {
    const root = await rootWith(".nas-mcp-trash", "#recycle", "notes.md~");
    const { code, stderr } = await runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: TEST_TOKEN });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/migration|not a mount point/i);
    expect(stderr).not.toMatch(/reserved/i);
  });

  it("refuses a Root with no Mounts", async () => {
    const { code, stderr } = await run(await rootWith());
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/no Mounts/i);
  });

  it("refuses a file at the top of the Root", async () => {
    const { code, stderr } = await run(await rootWith("docs", "loose.txt~"));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/loose\.txt/);
  });

  it("refuses a symlink at the top of the Root", async () => {
    const root = await rootWith("docs");
    await symlink(path.join(root, "docs"), path.join(root, "alias"));
    const { code, stderr } = await run(root);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/alias/);
  });

  for (const bad of [".hidden", "@eaDir", "#recycle", ".nas-mcp-trash"]) {
    it(`refuses the Mount name "${bad}"`, async () => {
      const { code, stderr } = await run(await rootWith("docs", bad));
      expect(code).not.toBe(0);
      expect(stderr).toContain(bad);
    });
  }

  it("refuses a Mount name that matches a hidden pattern", async () => {
    const { code, stderr } = await run(await rootWith("docs", "secret"), { NAS_MCP_HIDDEN_PATTERNS: "SECRET" });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/secret/);
  });

  it("refuses Mount names that differ only in case (on a case-sensitive filesystem)", async () => {
    const root = await rootWith("docs");
    await mkdir(path.join(root, "Docs")).catch(() => {});
    if (!existsSync(path.join(root, "DOCS"))) {
      // Case-sensitive: "docs" and "Docs" are two folders.
      const { code, stderr } = await run(root);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/case/i);
    }
  });

  it.skipIf(asRoot)("logs a warning for a Mount the server cannot write to", async () => {
    const s = await startServer({ mounts: ["docs", "locked"], setup: (root) => chmod(path.join(root, "locked"), 0o555) });
    try {
      const warning = s.stdoutLines().find((l: any) => l?.type === "warning") as any;
      expect(warning).toMatchObject({ mount: "locked" });
      expect(warning.message).toMatch(/read-only/i);
    } finally {
      await s.stop();
    }
  });
});

// Only the read-only parts need a non-root user (root can write through chmod 0o555).
describe("several Mounts", () => {
  let s: TestServer;
  /** archive's entries on disk at startup (it must never change). */
  let archiveBefore: string[];
  beforeAll(async () => {
    s = await startServer({
      mounts: ["docs", "photos", "archive"],
      layout: {
        "docs/a.md": "a",
        "docs/b.md": "b",
        "docs/c.md": "c",
        "docs/private/x.md": "x",
        "docs/sub/.nas-mcp-trash/visible.md": "deeper trash-named folders are ordinary",
        "photos/private/y.jpg": "y",
        "photos/sub/x.md": "x in photos",
        "photos/sub/del.md": "delete me",
        "photos/p.md": "photo notes",
        "photos/m1.md": "m1",
        "photos/m2.md": "m2",
        "archive/old.md": "old",
        [`archive/${TRASH_DIR}/${daysAgo(400)}/ancient.md`]: "ancient",
        [`docs/${TRASH_DIR}/${daysAgo(400)}/stale.md`]: "stale",
        "archive/.old.md.nas-mcp-tmp-0123456789ab": "leftover",
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "docs/private" },
      setup: async (root) => {
        await symlink(path.join(root, "photos", "sub"), path.join(root, "docs", "to-photos"));
        await symlink(path.join(root, "archive"), path.join(root, "docs", "to-archive"));
        await symlink(path.join(root, "archive", "old.md"), path.join(root, "docs", "old-link.md"));
        await symlink(root, path.join(root, "docs", "r"));
        archiveBefore = await allEntries(path.join(root, "archive"));
        if (!asRoot) await chmod(path.join(root, "archive"), 0o555);
      },
    });
  });
  afterAll(() => s.stop());

  async function expectError(tool: string, args: Record<string, unknown>, code = "forbidden") {
    const r = await s.call(tool, args);
    expect(r.isError, `${tool} ${JSON.stringify(args)}: ${textOf(r)}`).toBe(true);
    expect(textOf(r)).toMatch(new RegExp(`^${code}`));
    return textOf(r);
  }

  describe("the virtual top level", () => {
    it("lists the Mounts as folders", async () => {
      const r = await s.call("list", { path: "" });
      const entries = (r.structuredContent as any).entries;
      expect(entries.map((e: any) => [e.path, e.type])).toEqual([
        ["archive", "folder"],
        ["docs", "folder"],
        ["photos", "folder"],
      ]);
    });

    it.skipIf(asRoot)("marks read-only Mounts in list and stat", async () => {
      const r = await s.call("list", { path: "" });
      expect((r.structuredContent as any).entries.map((e: any) => [e.path, e.readOnly])).toEqual([
        ["archive", true],
        ["docs", undefined],
        ["photos", undefined],
      ]);
      expect((await s.call("stat", { path: "archive" })).structuredContent).toMatchObject({ type: "folder", readOnly: true });
      expect((await s.call("stat", { path: "docs" })).structuredContent).not.toHaveProperty("readOnly");
    });

    it("searches across all Mounts", async () => {
      const r = await s.call("search", { name: "*.md" });
      const paths = (r.structuredContent as any).entries.map((e: any) => e.path);
      expect(paths).toEqual(expect.arrayContaining(["docs/b.md", "photos/p.md", "archive/old.md"]));
    });

    it("refuses to create anything directly at the top level", async () => {
      await expectError("write", { path: "loose.md", content: "x" });
      await expectError("mkdir", { path: "newmount" });
      await expectError("mkdir", { path: "docs" });
      await expectError("move", { from: "docs/b.md", to: "b.md" });
      expect(existsSync(path.join(s.root, "loose.md"))).toBe(false);
      expect(existsSync(path.join(s.root, "newmount"))).toBe(false);
    });

    it("refuses to delete, rename or replace a Mount", async () => {
      await expectError("delete", { path: "docs" });
      await expectError("move", { from: "docs", to: "docs2" });
      await expectError("move", { from: "photos/p.md", to: "docs", overwrite: true });
      expect(existsSync(path.join(s.root, "docs/b.md"))).toBe(true);
    });

    it("reports a Path outside every Mount as not found", async () => {
      await expectError("read", { path: "nope/x.md" }, "not_found");
    });
  });

  describe("through a symlink to the Root", () => {
    it("refuses to create anything at the top level", async () => {
      await expectError("write", { path: "docs/r/loose.md", content: "x" });
      await expectError("mkdir", { path: "docs/r/newmount" });
      expect(existsSync(path.join(s.root, "loose.md"))).toBe(false);
      expect(existsSync(path.join(s.root, "newmount"))).toBe(false);
    });

    it("refuses to delete or rename a Mount", async () => {
      await expectError("delete", { path: "docs/r/photos" });
      await expectError("move", { from: "docs/r/photos", to: "docs/x" });
      expect(existsSync(path.join(s.root, "photos/p.md"))).toBe(true);
      expect(existsSync(path.join(s.root, "docs/x"))).toBe(false);
    });

    it("refuses a move into another Mount", async () => {
      await expectError("move", { from: "docs/c.md", to: "docs/r/photos/c.md" }, "invalid");
      expect(existsSync(path.join(s.root, "docs/c.md"))).toBe(true);
      expect(existsSync(path.join(s.root, "photos/c.md"))).toBe(false);
    });
  });

  describe("a folder at the top of the Root that is not a Mount", () => {
    it("is not listed or searched, even through a symlink", async () => {
      await mkdir(path.join(s.root, "stray"));
      await writeFile(path.join(s.root, "stray", "secret.md"), "stray-secret");
      await symlink(path.join(s.root, "stray"), path.join(s.root, "docs", "to-stray"));
      try {
        const listed = (await s.call("list", { path: "docs", depth: 2 })).structuredContent as any;
        const named = (await s.call("search", { name: "*" })).structuredContent as any;
        const grep = (await s.call("search", { content: "stray-secret" })).structuredContent as any;
        for (const p of [...listed.entries, ...named.entries].map((e: any) => e.path)) {
          expect(p).not.toMatch(/stray|secret/);
        }
        expect(grep.matches).toEqual([]);
      } finally {
        await rm(path.join(s.root, "docs", "to-stray"));
        await rm(path.join(s.root, "stray"), { recursive: true });
      }
    });
  });

  describe.skipIf(asRoot)("a read-only Mount", () => {
    it("can be read", async () => {
      expect(textOf(await s.call("read", { path: "archive/old.md" }))).toBe("old");
    });

    it("refuses every change", async () => {
      await expectError("write", { path: "archive/new.md", content: "x" });
      await expectError("write", { path: "archive/old.md", content: "x", overwrite: true });
      await expectError("edit", { path: "archive/old.md", oldString: "old", newString: "new" });
      await expectError("mkdir", { path: "archive/sub" });
      await expectError("delete", { path: "archive/old.md" });
      await expectError("move", { from: "archive/old.md", to: "archive/renamed.md" });
      expect(await allEntries(path.join(s.root, "archive"))).toEqual(archiveBefore);
    });

    it("refuses every change through a symlink into it", async () => {
      await expectError("write", { path: "docs/to-archive/n.md", content: "x" });
      await expectError("write", { path: "docs/old-link.md", content: "x", overwrite: true });
      await expectError("edit", { path: "docs/old-link.md", oldString: "old", newString: "new" });
      await expectError("mkdir", { path: "docs/to-archive/x" });
      await expectError("delete", { path: "docs/to-archive/old.md" });
      await expectError("move", { from: "docs/to-archive/old.md", to: "docs/to-archive/r.md" });
      expect(await allEntries(path.join(s.root, "archive"))).toEqual(archiveBefore);
      expect(await readFile(path.join(s.root, "archive/old.md"), "utf8")).toBe("old");
    });

    it("says why", async () => {
      expect(await expectError("write", { path: "archive/new.md", content: "x" })).toMatch(/read-only/i);
    });

    it("is skipped by the Trash purge and the temp-file cleanup", async () => {
      const line = await s.waitForAudit((l) => l.action === "trash_purge");
      expect(line.purged).toEqual([`docs/${TRASH_DIR}/${daysAgo(400)}`]);
      expect(existsSync(path.join(s.root, `archive/${TRASH_DIR}/${daysAgo(400)}/ancient.md`))).toBe(true);
      expect(existsSync(path.join(s.root, "archive/.old.md.nas-mcp-tmp-0123456789ab"))).toBe(true);
    });
  });

  describe("Trash per Mount", () => {
    it("deletes into the Mount's own Trash and audits the full Trash Path", async () => {
      const r = await s.call("delete", { path: "docs/a.md" });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(await trashFiles(s.root, "docs")).toContainEqual({ path: expect.stringMatching(new RegExp(`^${DAY}/a\\.md$`)), content: "a" });
      const line = await s.waitForAudit((l) => l.tool === "delete" && (l.paths as string[]).includes("docs/a.md"));
      expect(line.trashed).toEqual([expect.stringMatching(new RegExp(`^docs/${TRASH_DIR}/${DAY}/a\\.md$`))]);
    });

    it("puts an overwritten file's old version in that Mount's Trash", async () => {
      const r = await s.call("write", { path: "photos/p.md", content: "new", overwrite: true });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(await trashFiles(s.root, "photos")).toContainEqual({ path: expect.stringMatching(new RegExp(`^${DAY}/p\\.md$`)), content: "photo notes" });
    });

    it("puts a file replaced by a move in that Mount's Trash", async () => {
      const r = await s.call("move", { from: "photos/m1.md", to: "photos/m2.md", overwrite: true });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(await readFile(path.join(s.root, "photos/m2.md"), "utf8")).toBe("m1");
      expect(await trashFiles(s.root, "photos")).toContainEqual({ path: expect.stringMatching(new RegExp(`^${DAY}/m2\\.md$`)), content: "m2" });
      const line = await s.waitForAudit((l) => l.tool === "move" && (l.paths as string[]).includes("photos/m2.md"));
      expect(line.trashed).toEqual([expect.stringMatching(new RegExp(`^photos/${TRASH_DIR}/`))]);
    });

    it("deletes through a symlink into the real target's Mount Trash", async () => {
      const r = await s.call("delete", { path: "docs/to-photos/del.md" });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(existsSync(path.join(s.root, "photos/sub/del.md"))).toBe(false);
      expect(await trashFiles(s.root, "photos")).toContainEqual({ path: expect.stringMatching(new RegExp(`^${DAY}/sub/del\\.md$`)), content: "delete me" });
      const line = await s.waitForAudit((l) => l.tool === "delete" && (l.paths as string[]).includes("docs/to-photos/del.md"));
      expect(line.trashed).toEqual([expect.stringMatching(new RegExp(`^photos/${TRASH_DIR}/`))]);
    });

    it("purges each writable Mount's Trash and audits full Paths", async () => {
      expect(existsSync(path.join(s.root, `docs/${TRASH_DIR}/${daysAgo(400)}`))).toBe(false);
      const line = await s.waitForAudit((l) => l.action === "trash_purge");
      expect(line.purged).toContain(`docs/${TRASH_DIR}/${daysAgo(400)}`);
    });

    it("hides the Trash at the top of every Mount, and only there", async () => {
      await expectError("read", { path: `docs/${TRASH_DIR}/${daysAgo(400)}/stale.md` });
      const r = await s.call("list", { path: "docs" });
      expect((r.structuredContent as any).entries.map((e: any) => e.name)).not.toContain(TRASH_DIR);
      expect(textOf(await s.call("read", { path: "docs/sub/.nas-mcp-trash/visible.md" }))).toMatch(/ordinary/);
    });
  });

  describe("between Mounts", () => {
    it("refuses a move to another Mount", async () => {
      const msg = await expectError("move", { from: "docs/b.md", to: "photos/b.md" }, "invalid");
      expect(msg).toMatch(/Mount/);
      expect(existsSync(path.join(s.root, "docs/b.md"))).toBe(true);
    });

    it("refuses a move into another Mount through a symlink", async () => {
      await expectError("move", { from: "docs/b.md", to: "docs/to-photos/b.md" }, "invalid");
      expect(existsSync(path.join(s.root, "photos/sub/b.md"))).toBe(false);
    });

    it("refuses a move out of another Mount through a symlink", async () => {
      await expectError("move", { from: "docs/to-photos/x.md", to: "docs/x.md" }, "invalid");
      expect(existsSync(path.join(s.root, "photos/sub/x.md"))).toBe(true);
      expect(existsSync(path.join(s.root, "docs/x.md"))).toBe(false);
    });

    it("writes through a symlink into the real target's Mount and its Trash", async () => {
      expect((await s.call("write", { path: "docs/to-photos/n.md", content: "1" })).isError).toBeFalsy();
      expect((await s.call("write", { path: "docs/to-photos/n.md", content: "2", overwrite: true })).isError).toBeFalsy();
      expect(await readFile(path.join(s.root, "photos/sub/n.md"), "utf8")).toBe("2");
      expect(await trashFiles(s.root, "photos")).toContainEqual({ path: expect.stringMatching(new RegExp(`^${DAY}/sub/n\\.md$`)), content: "1" });
    });
  });

  describe("hidden patterns", () => {
    it("apply to the full Path, so a pattern with / names one Mount", async () => {
      await expectError("read", { path: "docs/private/x.md" });
      expect(textOf(await s.call("read", { path: "photos/private/y.jpg" }))).toBe("y");
    });
  });
});
