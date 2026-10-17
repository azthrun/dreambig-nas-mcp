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
import { TRASH_DIR, trashFiles } from "./trash-helpers.js";

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

describe.skipIf(asRoot)("several Mounts", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      mounts: ["docs", "photos", "archive"],
      layout: {
        "docs/a.md": "a",
        "docs/b.md": "b",
        "docs/private/x.md": "x",
        "docs/sub/.nas-mcp-trash/visible.md": "deeper trash-named folders are ordinary",
        "photos/private/y.jpg": "y",
        "photos/sub/": "",
        "photos/p.md": "photo notes",
        "archive/old.md": "old",
        [`archive/${TRASH_DIR}/${daysAgo(400)}/ancient.md`]: "ancient",
        [`docs/${TRASH_DIR}/${daysAgo(400)}/stale.md`]: "stale",
        "archive/.old.md.nas-mcp-tmp-0123456789ab": "leftover",
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "docs/private" },
      setup: async (root) => {
        await symlink(path.join(root, "photos", "sub"), path.join(root, "docs", "to-photos"));
        await chmod(path.join(root, "archive"), 0o555);
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
    it("lists the Mounts as folders, marking read-only ones", async () => {
      const r = await s.call("list", { path: "" });
      const entries = (r.structuredContent as any).entries;
      expect(entries.map((e: any) => [e.path, e.type, e.readOnly])).toEqual([
        ["archive", "folder", true],
        ["docs", "folder", undefined],
        ["photos", "folder", undefined],
      ]);
    });

    it("stats a Mount, reporting readOnly", async () => {
      expect((await s.call("stat", { path: "archive" })).structuredContent).toMatchObject({ type: "folder", readOnly: true });
      expect((await s.call("stat", { path: "docs" })).structuredContent).not.toHaveProperty("readOnly");
    });

    it("searches across all Mounts", async () => {
      const r = await s.call("search", { name: "*.md" });
      const paths = (r.structuredContent as any).entries.map((e: any) => e.path);
      expect(paths).toEqual(expect.arrayContaining(["docs/a.md", "photos/p.md", "archive/old.md"]));
    });

    it("refuses to create anything directly at the top level", async () => {
      await expectError("write", { path: "loose.md", content: "x" });
      await expectError("mkdir", { path: "newmount" });
      await expectError("mkdir", { path: "docs" });
      await expectError("move", { from: "docs/a.md", to: "a.md" });
      expect(existsSync(path.join(s.root, "loose.md"))).toBe(false);
      expect(existsSync(path.join(s.root, "newmount"))).toBe(false);
    });

    it("refuses to delete, rename or replace a Mount", async () => {
      await expectError("delete", { path: "docs" });
      await expectError("move", { from: "docs", to: "docs2" });
      await expectError("move", { from: "photos/p.md", to: "docs", overwrite: true });
      expect(existsSync(path.join(s.root, "docs/a.md"))).toBe(true);
    });

    it("reports a Path outside every Mount as not found", async () => {
      await expectError("read", { path: "nope/x.md" }, "not_found");
    });
  });

  describe("a read-only Mount", () => {
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
      expect(await readFile(path.join(s.root, "archive/old.md"), "utf8")).toBe("old");
    });

    it("says why", async () => {
      expect(await expectError("write", { path: "archive/new.md", content: "x" })).toMatch(/read-only/i);
    });

    it("is skipped by the Trash purge and the temp-file cleanup", async () => {
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

    it("purges each writable Mount's Trash and audits full Paths", async () => {
      expect(existsSync(path.join(s.root, `docs/${TRASH_DIR}/${daysAgo(400)}`))).toBe(false);
      const line = await s.waitForAudit((l) => l.action === "trash_purge");
      expect(line.purged).toEqual([`docs/${TRASH_DIR}/${daysAgo(400)}`]);
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
