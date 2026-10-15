import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";
import { trashFiles } from "./trash-helpers.js";

const N = 12;

/** Concurrent Destructive Operations must never lose content: every replaced or deleted version ends up in the Trash. */
describe("concurrent Destructive Operations", () => {
  let s: TestServer;
  beforeAll(async () => {
    const layout: Record<string, string> = { "x.md": "v0", "target.md": "t0" };
    for (let i = 0; i < N; i++) layout[`d${i}/same.md`] = `d${i}`;
    s = await startServer({ layout, env: { NAS_MCP_TRASH_RETENTION_DAYS: "0" } });
  });
  afterAll(() => s.stop());

  it("keeps every overwritten version when the same file is overwritten concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => s.call("write", { path: "x.md", content: `v${i + 1}`, overwrite: true })),
    );
    for (const r of results) expect(r.isError, textOf(r)).toBeFalsy();

    const final = await readFile(path.join(s.root, "x.md"), "utf8");
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.split("/").pop()!.startsWith("x"));
    expect(trashed).toHaveLength(N);
    const all = [final, ...trashed.map((f) => f.content)].sort();
    expect(all).toEqual(Array.from({ length: N + 1 }, (_, i) => `v${i}`).sort());
  });

  it("keeps every replaced target when moves overwrite the same target concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => s.call("move", { from: `d${i}/same.md`, to: "target.md", overwrite: true })),
    );
    for (const r of results) expect(r.isError, textOf(r)).toBeFalsy();

    const final = await readFile(path.join(s.root, "target.md"), "utf8");
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.split("/").pop()!.startsWith("target"));
    const all = [final, ...trashed.map((f) => f.content)].sort();
    expect(all).toEqual(["t0", ...Array.from({ length: N }, (_, i) => `d${i}`)].sort());
  });
});
