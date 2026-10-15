import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, startServer, textOf, type TestServer } from "./harness.js";

const names = (r: any) => (r.structuredContent.entries as { path: string }[]).map((e) => e.path).sort();

describe("Root sandbox", () => {
  let s: TestServer;
  let outside: string;

  beforeAll(async () => {
    outside = await makeTempDir("nas-mcp-outside-");
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    s = await startServer({
      layout: {
        "docs/readme.md": "hi",
        "docs/@eaDir/thumb.jpg": "x",
        "docs/.DS_Store": "x",
        "#recycle/old.txt": "x",
        "#snapshot/snap.txt": "x",
        ".nas-mcp-trash/2026-01-01/gone.txt": "x",
        "private/diary.md": "x",
        "drafts/a.tmp": "x",
        "drafts/keep.md": "x",
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "private, *.tmp", NAS_MCP_TRASH_RETENTION_DAYS: "0" },
      setup: async (root) => {
        await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
        await symlink(outside, path.join(root, "leakdir"));
        await symlink(path.join(root, "docs", "readme.md"), path.join(root, "alias.md"));
        await symlink("docs", path.join(root, "docs-link"));
        await symlink(path.join(root, ".nas-mcp-trash"), path.join(root, "trash-link"));
        await mkdir(path.join(root, "sub"));
        await symlink("../..", path.join(root, "sub", "up"));
      },
    });
  });
  afterAll(async () => {
    await s.stop();
    await rm(outside, { recursive: true, force: true });
  });

  async function expectRejected(tool: string, p: string) {
    const r = await s.call(tool, { path: p });
    expect(r.isError, `${tool} ${p}: ${textOf(r)}`).toBe(true);
    expect(textOf(r)).toMatch(/^forbidden/);
    const line = await s.waitForAudit((l) => l.tool === tool && (l.paths as string[] | undefined)?.includes(p) === true);
    expect(line).toMatchObject({ result: "rejected", reason: "forbidden" });
  }

  describe("Path escapes", () => {
    for (const tool of ["list", "stat"]) {
      it(`${tool} rejects ".." escapes`, async () => {
        await expectRejected(tool, "../");
        await expectRejected(tool, "docs/../../etc");
      });
      it(`${tool} rejects absolute paths`, async () => {
        await expectRejected(tool, "/etc");
        await expectRejected(tool, s.root);
      });
      it(`${tool} rejects symlinks pointing outside the Root`, async () => {
        await expectRejected(tool, "leakdir");
        await expectRejected(tool, "sub/up");
      });
    }
    it("stat rejects a file symlink pointing outside the Root", async () => {
      await expectRejected("stat", "leak.txt");
    });
    it("rejects a Path that goes through an escaping symlink", async () => {
      await expectRejected("stat", "leakdir/secret.txt");
    });
  });

  describe("symlinks inside the Root", () => {
    it("stat follows a file symlink inside the Root", async () => {
      const r = await s.call("stat", { path: "alias.md" });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ path: "alias.md", type: "file", size: 2 });
    });
    it("list follows a folder symlink inside the Root", async () => {
      const r = await s.call("list", { path: "docs-link" });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(names(r)).toEqual(["docs-link/readme.md"]);
    });
    it("list shows in-Root symlinks but not escaping ones", async () => {
      const all = names(await s.call("list", {}));
      expect(all).toContain("alias.md");
      expect(all).toContain("docs-link");
      expect(all).not.toContain("leak.txt");
      expect(all).not.toContain("leakdir");
      expect(all).not.toContain("trash-link");
    });
  });

  describe("Hidden Entries", () => {
    it("never appear in list (defaults + custom patterns), at any depth", async () => {
      const all = names(await s.call("list", { depth: 3 }));
      expect(all).toEqual(
        ["alias.md", "docs", "docs-link", "docs-link/readme.md", "docs/readme.md", "drafts", "drafts/keep.md", "sub"].sort(),
      );
    });

    for (const p of [
      ".nas-mcp-trash",
      ".nas-mcp-trash/2026-01-01/gone.txt",
      "docs/@eaDir",
      "docs/@eaDir/thumb.jpg",
      "docs/.DS_Store",
      "#recycle/old.txt",
      "#snapshot",
      "private",
      "private/diary.md",
      "drafts/a.tmp",
      "trash-link",
    ]) {
      it(`stat refuses ${p}`, async () => {
        await expectRejected("stat", p);
      });
    }

    it("list refuses a Hidden Entry folder", async () => {
      await expectRejected("list", "#recycle");
      await expectRejected("list", "private");
    });
  });
});
