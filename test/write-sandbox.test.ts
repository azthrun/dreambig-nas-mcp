import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, startServer, textOf, type TestServer } from "./harness.js";
import { trashFiles } from "./trash-helpers.js";

/** Write targets go through the Root sandbox (resolveForCreate) just like reads. */
describe("write targets and the Root sandbox", () => {
  let s: TestServer;
  let outside: string;

  beforeAll(async () => {
    outside = await makeTempDir("nas-mcp-outside-");
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    s = await startServer({
      layout: { "docs/real.md": "real v1", ".nas-mcp-trash/2026-01-01/gone.txt": "x" },
      env: { NAS_MCP_HIDDEN_PATTERNS: "private" },
      setup: async (root) => {
        await symlink(outside, path.join(root, "leakdir"));
        await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
        await symlink(path.join(root, "nowhere.txt"), path.join(root, "dangling.txt"));
        await symlink(path.join(root, "docs", "real.md"), path.join(root, "alias.md"));
      },
    });
  });
  afterAll(async () => {
    await s.stop();
    await rm(outside, { recursive: true, force: true });
  });

  async function expectRejected(p: string, overwrite = true) {
    const r = await s.call("write", { path: p, content: "pwned", overwrite });
    expect(r.isError, `write ${p}: ${textOf(r)}`).toBe(true);
    expect(textOf(r)).toMatch(/^forbidden/);
    const line = await s.waitForAudit((l) => l.tool === "write" && (l.paths as string[] | undefined)?.includes(p) === true);
    expect(line).toMatchObject({ result: "rejected", reason: "forbidden" });
  }

  it("refuses the Trash and anything inside it", async () => {
    await expectRejected(".nas-mcp-trash/2026-01-01/gone.txt");
    await expectRejected(".nas-mcp-trash/new.txt");
    expect(await readFile(path.join(s.root, ".nas-mcp-trash/2026-01-01/gone.txt"), "utf8")).toBe("x");
  });

  it("refuses other Hidden Entries, including custom patterns", async () => {
    await expectRejected("docs/@eaDir/x.txt");
    await expectRejected("#recycle/x.txt");
    await expectRejected("private/diary.md");
  });

  it("refuses the Root itself, `..` and absolute paths", async () => {
    await expectRejected("");
    await expectRejected("docs/../../x.txt");
    await expectRejected(path.join(s.root, "docs", "abs.txt"));
  });

  it("refuses to write through a symlinked folder that leaves the Root", async () => {
    await expectRejected("leakdir/new.txt");
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("refuses to overwrite through a symlink to a file outside the Root", async () => {
    await expectRejected("leak.txt");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret");
  });

  it("refuses to write through a dangling symlink", async () => {
    await expectRejected("dangling.txt", false);
    expect(await readdir(s.root)).not.toContain("nowhere.txt");
  });

  it("overwriting through an in-Root symlink replaces the target file and trashes its old version", async () => {
    const r = await s.call("write", { path: "alias.md", content: "real v2", overwrite: true });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readFile(path.join(s.root, "docs/real.md"), "utf8")).toBe("real v2");
    const trashed = (await trashFiles(s.root)).filter((f) => f.content === "real v1");
    expect(trashed.map((f) => f.path)).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}\/docs\/real\.md$/)]);
  });
});
