import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";

describe("mkdir", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ layout: { "photos/": "", "file.txt": "keep" } });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("creates nested folders", async () => {
    const r = await s.call("mkdir", { path: "projects/2026/q4" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: "projects/2026/q4", created: true });
    expect((await stat(path.join(s.root, "projects/2026/q4"))).isDirectory()).toBe(true);
  });

  it("succeeds without changes when the folder already exists", async () => {
    const r = await s.call("mkdir", { path: "photos" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: "photos", created: false });
  });

  it("refuses when a file is in the way", async () => {
    expect(textOf(await s.call("mkdir", { path: "file.txt" }))).toMatch(/^exists/);
    expect(textOf(await s.call("mkdir", { path: "file.txt/sub" }))).toMatch(/^not_a_folder/);
    expect(await readFile(path.join(s.root, "file.txt"), "utf8")).toBe("keep");
  });

  it("refuses Hidden Entries and the Root itself", async () => {
    for (const p of [".nas-mcp-trash/x", "@eaDir", ""]) {
      expect(textOf(await s.call("mkdir", { path: p }))).toMatch(/^forbidden/);
    }
  });

  it("emits an audit line", async () => {
    await s.call("mkdir", { path: "audited/a" });
    const line = await s.waitForAudit((l) => l.tool === "mkdir" && (l.paths as string[])[0] === "audited/a");
    expect(line).toMatchObject({ result: "ok", paths: ["audited/a"] });
  });

  it("is not a Destructive Operation, while write and edit are", async () => {
    const { tools } = await s.client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.mkdir).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.write).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.edit).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
