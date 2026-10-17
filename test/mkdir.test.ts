import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";

describe("mkdir", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ layout: { "m/photos/": "", "m/file.txt": "keep" } });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("creates nested folders", async () => {
    const r = await s.call("mkdir", { path: "m/projects/2026/q4" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: "m/projects/2026/q4", created: true });
    expect((await stat(path.join(s.root, "m/projects/2026/q4"))).isDirectory()).toBe(true);
  });

  it("succeeds without changes when the folder already exists", async () => {
    const r = await s.call("mkdir", { path: "m/photos" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: "m/photos", created: false });
  });

  it("refuses when a file is in the way", async () => {
    expect(textOf(await s.call("mkdir", { path: "m/file.txt" }))).toMatch(/^exists/);
    expect(textOf(await s.call("mkdir", { path: "m/file.txt/sub" }))).toMatch(/^not_a_folder/);
    expect(await readFile(path.join(s.root, "m/file.txt"), "utf8")).toBe("keep");
  });

  it("refuses Hidden Entries, the Root itself and a Mount", async () => {
    for (const p of ["m/.nas-mcp-trash/x", "m/@eaDir", "", "m"]) {
      expect(textOf(await s.call("mkdir", { path: p }))).toMatch(/^forbidden/);
    }
  });

  it("emits an audit line", async () => {
    await s.call("mkdir", { path: "m/audited/a" });
    const line = await s.waitForAudit((l) => l.tool === "mkdir" && (l.paths as string[])[0] === "m/audited/a");
    expect(line).toMatchObject({ result: "ok", paths: ["m/audited/a"] });
  });

  it("is not a Destructive Operation, while write and edit are", async () => {
    const { tools } = await s.client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.mkdir).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.write).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.edit).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
