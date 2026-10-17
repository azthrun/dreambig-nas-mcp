import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, lstat, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, startServer, textOf, type TestServer } from "./harness.js";
import { TRASH_DIR, trashFiles } from "./trash-helpers.js";

const gone = (p: string) => access(p).then(() => false, () => true);
const DAY = String.raw`\d{4}-\d{2}-\d{2}`;

describe("move", () => {
  let s: TestServer;
  let outside: string;
  const read = (p: string) => readFile(path.join(s.root, "m", p), "utf8");

  beforeAll(async () => {
    outside = await makeTempDir("nas-mcp-outside-");
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    s = await startServer({
      layout: {
        "m/notes/draft.md": "draft",
        "m/projects/alpha/readme.md": "alpha",
        "m/projects/alpha/src/main.ts": "main",
        "m/projects/alpha/empty/": "",
        "m/over/src.md": "new version",
        "m/over/dst.md": "old version",
        "m/over/plain.md": "plain",
        "m/over/taken.md": "taken",
        "m/case/report.md": "report",
        "m/nest/a/b.md": "b",
        "m/blocker": "a file",
        "m/docs/real.md": "real",
        "m/private/diary.md": "diary",
        "m/docs/@eaDir/thumb.jpg": "thumb",
        "m/.nas-mcp-trash/2026-01-01/old.txt": "old",
        "m/audit/x.txt": "x",
        "m/audit/y.txt": "y",
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "private", NAS_MCP_TRASH_RETENTION_DAYS: "0" },
      setup: async (root) => {
        await symlink(path.join(root, "m/docs", "real.md"), path.join(root, "m/alias.md"));
        await symlink(path.join(outside, "secret.txt"), path.join(root, "m/leak.txt"));
        await symlink(outside, path.join(root, "m/leakdir"));
      },
    });
  });
  afterAll(async () => {
    await s.stop();
    await rm(outside, { recursive: true, force: true });
  });

  it("renames a file", async () => {
    const r = await s.call("move", { from: "m/notes/draft.md", to: "m/notes/final.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ from: "m/notes/draft.md", to: "m/notes/final.md", replaced: false });
    expect(await gone(path.join(s.root, "m/notes/draft.md"))).toBe(true);
    expect(await read("notes/final.md")).toBe("draft");
  });

  it("moves a folder with its contents, creating missing parent folders", async () => {
    const r = await s.call("move", { from: "m/projects/alpha", to: "m/archive/2026/alpha" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await gone(path.join(s.root, "m/projects/alpha"))).toBe(true);
    expect(await read("archive/2026/alpha/readme.md")).toBe("alpha");
    expect(await read("archive/2026/alpha/src/main.ts")).toBe("main");
    expect((await lstat(path.join(s.root, "m/archive/2026/alpha/empty"))).isDirectory()).toBe(true);
  });

  it("renames a file changing only the letter case", async () => {
    const r = await s.call("move", { from: "m/case/report.md", to: "m/case/Report.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readdir(path.join(s.root, "m/case"))).toEqual(["Report.md"]);
    expect(await read("case/Report.md")).toBe("report");
    expect((await trashFiles(s.root)).filter((f) => f.path.includes("/case/"))).toEqual([]);
  });

  it("refuses to replace an existing target without overwrite", async () => {
    const r = await s.call("move", { from: "m/over/plain.md", to: "m/over/taken.md" });
    expect(textOf(r)).toMatch(/^exists/);
    expect(await read("over/plain.md")).toBe("plain");
    expect(await read("over/taken.md")).toBe("taken");
  });

  it("with overwrite, replaces the target and keeps the replaced item in the Trash", async () => {
    const r = await s.call("move", { from: "m/over/src.md", to: "m/over/dst.md", overwrite: true });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ replaced: true });
    expect(await gone(path.join(s.root, "m/over/src.md"))).toBe(true);
    expect(await read("over/dst.md")).toBe("new version");
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.includes("/over/"));
    expect(trashed).toEqual([{ path: expect.stringMatching(new RegExp(`^${DAY}/over/dst\\.md$`)), content: "old version" }]);
  });

  it("refuses to move a folder into itself or onto itself", async () => {
    expect(textOf(await s.call("move", { from: "m/nest", to: "m/nest/a/nest" }))).toMatch(/^invalid/);
    expect(textOf(await s.call("move", { from: "m/nest", to: "m/nest", overwrite: true }))).toMatch(/^invalid/);
    expect(await read("nest/a/b.md")).toBe("b");
    expect((await trashFiles(s.root)).filter((f) => f.path.includes("/nest/"))).toEqual([]);
  });

  it("reports a file in the way of a target parent as not_a_folder", async () => {
    const r = await s.call("move", { from: "m/audit/y.txt", to: "m/blocker/y.txt" });
    expect(textOf(r)).toMatch(/^not_a_folder/);
    expect(await read("audit/y.txt")).toBe("y");
  });

  it("moves a symlink itself, not its target", async () => {
    const r = await s.call("move", { from: "m/alias.md", to: "m/links/alias.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect((await lstat(path.join(s.root, "m/links/alias.md"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(s.root, "m/links/alias.md"))).toBe(path.join(s.root, "m/docs", "real.md"));
    expect(await read("docs/real.md")).toBe("real");
  });

  it("reports a missing source as not_found", async () => {
    expect(textOf(await s.call("move", { from: "m/notes/nope.md", to: "m/notes/x.md" }))).toMatch(/^not_found/);
  });

  async function expectRejected(from: string, to: string) {
    const r = await s.call("move", { from, to, overwrite: true });
    expect(r.isError, `move ${from} -> ${to}: ${textOf(r)}`).toBe(true);
    expect(textOf(r)).toMatch(/^forbidden/);
    const line = await s.waitForAudit(
      (l) => l.tool === "move" && l.result === "rejected" && (l.paths as string[] | undefined)?.some((p) => p === from || p === to) === true,
    );
    expect(line).toMatchObject({ reason: "forbidden" });
  }

  it("refuses to move into or out of the Trash and other Hidden Entries", async () => {
    await expectRejected("m/.nas-mcp-trash/2026-01-01/old.txt", "restored.txt");
    await expectRejected("m/audit/x.txt", ".nas-mcp-trash/x.txt");
    await expectRejected("m/.nas-mcp-trash", "trash-copy");
    await expectRejected("m/docs/@eaDir", "thumbs");
    await expectRejected("m/audit/x.txt", "docs/@eaDir/x.txt");
    await expectRejected("m/private/diary.md", "diary.md");
    await expectRejected("m/audit/x.txt", "private/x.txt");
    expect(await read(".nas-mcp-trash/2026-01-01/old.txt")).toBe("old");
    expect(await read("private/diary.md")).toBe("diary");
    expect(await read("audit/x.txt")).toBe("x");
  });

  it("refuses the Root, `..`, absolute paths and symlinks leading out of the Root", async () => {
    await expectRejected("", "root-copy");
    await expectRejected("m/audit/x.txt", "");
    await expectRejected("m/audit/x.txt", "../x.txt");
    await expectRejected("m/audit/x.txt", path.join(outside, "x.txt"));
    await expectRejected("m/leak.txt", "leak2.txt");
    await expectRejected("m/audit/x.txt", "leakdir/x.txt");
    await expectRejected("m/audit/x.txt", "leak.txt");
    expect(await readdir(outside)).toEqual(["secret.txt"]);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret");
    expect(await read("audit/x.txt")).toBe("x");
  });

  it("emits one audit line with source and target Paths", async () => {
    await s.call("move", { from: "m/audit/x.txt", to: "m/audit/z.txt" });
    const line = await s.waitForAudit((l) => l.tool === "move" && l.result === "ok" && (l.paths as string[])[0] === "m/audit/x.txt");
    expect(line).toMatchObject({ paths: ["m/audit/x.txt", "m/audit/z.txt"] });
    expect(line.trashed).toBeUndefined();
    const replaced = s.auditLines().find((l) => l.tool === "move" && l.result === "ok" && (l.paths as string[])[1] === "m/over/dst.md");
    expect(replaced?.trashed).toEqual([expect.stringMatching(new RegExp(`^m/${TRASH_DIR}/${DAY}/over/dst\\.md$`))]);
  });

  it("is advertised as a Destructive Operation", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === "move")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
