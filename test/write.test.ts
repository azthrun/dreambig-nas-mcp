import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";
import { allEntries, trashFiles } from "./trash-helpers.js";

describe("write", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ layout: { "m/notes/existing.md": "old\n" } });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("creates a text file, creating missing parent folders", async () => {
    const r = await s.call("write", { path: "m/reports/2026/q3/summary.md", content: "# Q3\nnaïve ✓\n" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readFile(path.join(s.root, "m/reports/2026/q3/summary.md"), "utf8")).toBe("# Q3\nnaïve ✓\n");
  });

  it("refuses to replace an existing file without overwrite", async () => {
    const r = await s.call("write", { path: "m/notes/existing.md", content: "new\n" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^exists/);
    expect(await readFile(path.join(s.root, "m/notes/existing.md"), "utf8")).toBe("old\n");
  });

  it("with overwrite, replaces the file and keeps the old version in a dated Trash folder", async () => {
    const r = await s.call("write", { path: "m/notes/existing.md", content: "new\n", overwrite: true });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readFile(path.join(s.root, "m/notes/existing.md"), "utf8")).toBe("new\n");

    const trashed = await trashFiles(s.root);
    expect(trashed).toHaveLength(1);
    expect(trashed[0].path).toMatch(/^\d{4}-\d{2}-\d{2}\/notes\/existing\.md$/);
    expect(trashed[0].content).toBe("old\n");
  });

  it("keeps every replaced version when the same file is overwritten again (collision-safe Trash names)", async () => {
    await s.call("write", { path: "m/notes/again.md", content: "v1" });
    for (const v of ["v2", "v3"]) {
      const r = await s.call("write", { path: "m/notes/again.md", content: v, overwrite: true });
      expect(r.isError, textOf(r)).toBeFalsy();
    }
    expect(await readFile(path.join(s.root, "m/notes/again.md"), "utf8")).toBe("v3");
    const versions = (await trashFiles(s.root)).filter((f) => /\/notes\/again\b/.test(f.path));
    expect(versions.map((v) => v.content).sort()).toEqual(["v1", "v2"]);
    for (const v of versions) expect(v.path).toMatch(/^\d{4}-\d{2}-\d{2}\/notes\/again.*\.md$/);
  });

  it("keeps the Trash invisible to list, stat, read and search once it holds replaced files", async () => {
    expect((await trashFiles(s.root)).length).toBeGreaterThan(0);
    const listed = await s.call("list", { path: "m", depth: 3 });
    expect(listed.isError, textOf(listed)).toBeFalsy();
    const paths = (listed.structuredContent!.entries as { path: string }[]).map((e) => e.path);
    expect(paths).toContain("m/notes/existing.md");
    expect(paths.filter((p) => p.includes("nas-mcp-trash"))).toEqual([]);
    expect(textOf(await s.call("stat", { path: "m/.nas-mcp-trash" }))).toMatch(/^forbidden/);
    const [trashed] = await trashFiles(s.root);
    expect(textOf(await s.call("read", { path: `m/.nas-mcp-trash/${trashed.path}` }))).toMatch(/^forbidden/);

    const byName = await s.call("search", { name: "existing*" });
    expect((byName.structuredContent!.entries as { path: string }[]).map((e) => e.path)).toEqual(["m/notes/existing.md"]);
    const byContent = await s.call("search", { content: "old" });
    expect(byContent.structuredContent!.matches).toEqual([]);
  });

  it("emits one audit line per write, naming the Path and where the old version went", async () => {
    await s.call("write", { path: "m/audit/a.txt", content: "1" });
    await s.call("write", { path: "m/audit/a.txt", content: "2", overwrite: true });
    await s.waitForAudit((l) => l.tool === "write" && (l.paths as string[])[0] === "m/audit/a.txt" && !!l.trashed);
    const lines = s.auditLines().filter((l) => l.tool === "write" && (l.paths as string[])[0] === "m/audit/a.txt");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ result: "ok", paths: ["m/audit/a.txt"] });
    expect(lines[0].trashed).toBeUndefined();
    expect(Number.isNaN(Date.parse(lines[0].time))).toBe(false);
    expect(lines[1]).toMatchObject({ result: "ok", paths: ["m/audit/a.txt"] });
    expect(lines[1].trashed).toEqual([expect.stringMatching(/^m\/\.nas-mcp-trash\/\d{4}-\d{2}-\d{2}\/audit\/a\.txt$/)]);
  });

  it("refuses to write over a folder", async () => {
    const r = await s.call("write", { path: "m/notes", content: "x", overwrite: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_a_file/);
    expect((await stat(path.join(s.root, "m/notes"))).isDirectory()).toBe(true);
  });

  it("refuses when a parent Path is a file", async () => {
    const r = await s.call("write", { path: "m/notes/existing.md/child.txt", content: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_a_folder/);
  });

  it("leaves no temp files behind after successful and failed writes", async () => {
    const all = await allEntries(s.root);
    expect(all.filter((e) => e.includes("nas-mcp-tmp"))).toEqual([]);
  });
});

describe("write when the Trash cannot be used", () => {
  let s: TestServer;
  beforeAll(async () => {
    // A file where the Trash folder should be: moving the old version to Trash fails.
    s = await startServer({ layout: { "m/doc.txt": "precious", "m/.nas-mcp-trash": "not a folder" } });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("fails without touching the existing file or leaving temp files", async () => {
    const r = await s.call("write", { path: "m/doc.txt", content: "new", overwrite: true });
    expect(r.isError).toBe(true);
    expect(await readFile(path.join(s.root, "m/doc.txt"), "utf8")).toBe("precious");
    expect(await allEntries(path.join(s.root, "m"))).toEqual([".nas-mcp-trash", "doc.txt"]);
  });
});
