import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, lstat, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, startServer, textOf, type TestServer } from "./harness.js";
import { TRASH_DIR, trashFiles } from "./trash-helpers.js";

const gone = (p: string) => access(p).then(() => false, () => true);
const DAY = String.raw`\d{4}-\d{2}-\d{2}`;

describe("delete", () => {
  let s: TestServer;
  let outside: string;
  beforeAll(async () => {
    outside = await makeTempDir("nas-mcp-outside-");
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    s = await startServer({
      layout: {
        "notes/plan.md": "plan\n",
        "projects/alpha/readme.md": "alpha",
        "projects/alpha/src/main.ts": "main",
        "projects/alpha/empty/": "",
        "clash/a": "a as a file",
        "docs/real.md": "real",
        "private/diary.md": "diary",
        "docs/@eaDir/thumb.jpg": "thumb",
        ".nas-mcp-trash/2026-01-01/old.txt": "old",
        "audit/x.txt": "x",
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "private", NAS_MCP_TRASH_RETENTION_DAYS: "0" },
      setup: async (root) => {
        await symlink(path.join(root, "docs", "real.md"), path.join(root, "alias.md"));
        await symlink(path.join(root, "docs"), path.join(root, "docs-link"));
        await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
        await symlink(outside, path.join(root, "leakdir"));
      },
    });
  });
  afterAll(async () => {
    await s.stop();
    await rm(outside, { recursive: true, force: true });
  });

  it("moves a file into the dated Trash folder under its original Path", async () => {
    const r = await s.call("delete", { path: "notes/plan.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await gone(path.join(s.root, "notes/plan.md"))).toBe(true);
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.includes("plan"));
    expect(trashed).toEqual([{ path: expect.stringMatching(new RegExp(`^${DAY}/notes/plan\\.md$`)), content: "plan\n" }]);
  });

  it("moves a folder with its contents into the Trash, keeping their relative layout", async () => {
    const r = await s.call("delete", { path: "projects/alpha" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await gone(path.join(s.root, "projects/alpha"))).toBe(true);
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.includes("/projects/alpha/"));
    expect(trashed.map((f) => f.path.replace(/^[^/]+\//, ""))).toEqual([
      "projects/alpha/readme.md",
      "projects/alpha/src/main.ts",
    ]);
    const [day] = trashed[0].path.split("/");
    expect((await lstat(path.join(s.root, TRASH_DIR, day, "projects/alpha/empty"))).isDirectory()).toBe(true);
  });

  it("keeps both entries when a file already sits in today's Trash where a folder is needed", async () => {
    // Trash `clash/a` as a file, then recreate `clash/a` as a folder and trash `clash/a/b`.
    expect((await s.call("delete", { path: "clash/a" })).isError).toBeFalsy();
    expect((await s.call("write", { path: "clash/a/b", content: "b inside folder a" })).isError).toBeFalsy();
    const r = await s.call("delete", { path: "clash/a/b" });
    expect(r.isError, textOf(r)).toBeFalsy();
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.includes("/clash/"));
    expect(trashed).toEqual([
      { path: expect.stringMatching(new RegExp(`^${DAY}/clash/a$`)), content: "a as a file" },
      { path: expect.stringMatching(new RegExp(`^${DAY}/clash/a \\(2\\)/b$`)), content: "b inside folder a" },
    ]);
  });

  it("deletes a symlink itself, leaving its target in place", async () => {
    const r = await s.call("delete", { path: "alias.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await gone(path.join(s.root, "alias.md"))).toBe(true);
    expect(await readFile(path.join(s.root, "docs/real.md"), "utf8")).toBe("real");
    const day = (await trashFiles(s.root)).find((f) => f.path.endsWith("/notes/plan.md"))!.path.split("/")[0];
    const inTrash = path.join(s.root, TRASH_DIR, day, "alias.md");
    expect((await lstat(inTrash)).isSymbolicLink()).toBe(true);
    expect(await readlink(inTrash)).toBe(path.join(s.root, "docs", "real.md"));
  });

  it("deleting through a symlinked folder trashes the entry under its real Path", async () => {
    await writeFile(path.join(s.root, "docs/via-link.md"), "via link");
    const r = await s.call("delete", { path: "docs-link/via-link.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await gone(path.join(s.root, "docs/via-link.md"))).toBe(true);
    const trashed = (await trashFiles(s.root)).filter((f) => f.content === "via link");
    expect(trashed.map((f) => f.path)).toEqual([expect.stringMatching(new RegExp(`^${DAY}/docs/via-link\\.md$`))]);
  });

  async function expectRejected(p: string) {
    const r = await s.call("delete", { path: p });
    expect(r.isError, `delete ${p}: ${textOf(r)}`).toBe(true);
    expect(textOf(r)).toMatch(/^forbidden/);
    const line = await s.waitForAudit((l) => l.tool === "delete" && (l.paths as string[] | undefined)?.includes(p) === true);
    expect(line).toMatchObject({ result: "rejected", reason: "forbidden" });
  }

  it("refuses the Root, the Trash and other Hidden Entries", async () => {
    await expectRejected("");
    await expectRejected(".nas-mcp-trash");
    await expectRejected(".nas-mcp-trash/2026-01-01/old.txt");
    await expectRejected("docs/@eaDir");
    await expectRejected("private/diary.md");
    expect(await readFile(path.join(s.root, ".nas-mcp-trash/2026-01-01/old.txt"), "utf8")).toBe("old");
    expect(await readFile(path.join(s.root, "private/diary.md"), "utf8")).toBe("diary");
    expect(await readFile(path.join(s.root, "docs/@eaDir/thumb.jpg"), "utf8")).toBe("thumb");
  });

  it("refuses `..`, absolute paths and symlinks leading out of the Root", async () => {
    await expectRejected("docs/../../x");
    await expectRejected(path.join(s.root, "docs"));
    await expectRejected("leak.txt");
    await expectRejected("leakdir/secret.txt");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret");
  });

  it("reports a missing entry as not_found", async () => {
    const r = await s.call("delete", { path: "notes/nope.md" });
    expect(textOf(r)).toMatch(/^not_found/);
  });

  it("emits one audit line naming the Path and where it went in the Trash", async () => {
    await s.call("delete", { path: "audit/x.txt" });
    const line = await s.waitForAudit((l) => l.tool === "delete" && l.result === "ok" && (l.paths as string[])[0] === "audit/x.txt");
    expect(line.trashed).toEqual([expect.stringMatching(new RegExp(`^${DAY}/audit/x\\.txt$`))]);
    expect(s.auditLines().filter((l) => l.tool === "delete" && (l.paths as string[])[0] === "audit/x.txt")).toHaveLength(1);
  });

  it("is advertised as a Destructive Operation", async () => {
    const { tools } = await s.client.listTools();
    const del = tools.find((t) => t.name === "delete");
    expect(del?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
