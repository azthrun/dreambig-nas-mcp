import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { utimes } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";

interface Entry {
  path: string;
  name: string;
  type: "file" | "folder" | "other";
  size: number;
  modified: string;
}
interface ListResult {
  path: string;
  entries: Entry[];
  nextCursor?: string;
}

const listOf = (r: any) => r.structuredContent as ListResult;
const paths = (r: any) => listOf(r).entries.map((e) => e.path);

describe("list", () => {
  let s: TestServer;
  beforeAll(async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 450; i++) big[`big/f${String(i).padStart(3, "0")}.txt`] = "";
    s = await startServer({
      layout: {
        "hello.txt": "hello world",
        "docs/a.md": "# a",
        "docs/sub/b.md": "b",
        "docs/sub/deeper/c.md": "c",
        "docs/sub/deeper/deepest/d.md": "d",
        "empty/": "",
        ...big,
      },
      setup: async (root) => {
        const t = new Date("2024-01-02T03:04:05Z");
        await utimes(path.join(root, "hello.txt"), t, t);
      },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("lists the Root one level deep by default with name, type, size, modified", async () => {
    const r = await s.call("list", {});
    expect(r.isError).toBeFalsy();
    const { entries } = listOf(r);
    expect(entries.map((e) => e.path).sort()).toEqual(["big", "docs", "empty", "hello.txt"]);
    const hello = entries.find((e) => e.name === "hello.txt")!;
    expect(hello).toMatchObject({ path: "hello.txt", type: "file", size: 11, modified: "2024-01-02T03:04:05.000Z" });
    expect(entries.find((e) => e.name === "docs")!.type).toBe("folder");
  });

  it("also returns the result as JSON text", async () => {
    const r = await s.call("list", { path: "docs" });
    expect(JSON.parse(textOf(r))).toEqual(r.structuredContent);
  });

  it("lists a sub-folder with Root-relative Paths", async () => {
    const r = await s.call("list", { path: "docs" });
    expect(paths(r).sort()).toEqual(["docs/a.md", "docs/sub"]);
  });

  it("lists an empty folder", async () => {
    expect(paths(await s.call("list", { path: "empty" }))).toEqual([]);
  });

  it("descends up to depth 3", async () => {
    expect(paths(await s.call("list", { path: "docs", depth: 2 })).sort()).toEqual([
      "docs/a.md",
      "docs/sub",
      "docs/sub/b.md",
      "docs/sub/deeper",
    ]);
    expect(paths(await s.call("list", { path: "docs", depth: 3 })).sort()).toEqual([
      "docs/a.md",
      "docs/sub",
      "docs/sub/b.md",
      "docs/sub/deeper",
      "docs/sub/deeper/c.md",
      "docs/sub/deeper/deepest",
    ]);
  });

  it("rejects depth > 3", async () => {
    const r = await s.call("list", { path: "docs", depth: 4 });
    expect(r.isError).toBe(true);
  });

  it("pages at 200 entries and the cursor returns the next pages", async () => {
    const p1 = listOf(await s.call("list", { path: "big" }));
    expect(p1.entries).toHaveLength(200);
    expect(p1.nextCursor).toBeTypeOf("string");
    const p2 = listOf(await s.call("list", { path: "big", cursor: p1.nextCursor }));
    expect(p2.entries).toHaveLength(200);
    const p3 = listOf(await s.call("list", { path: "big", cursor: p2.nextCursor }));
    expect(p3.entries).toHaveLength(50);
    expect(p3.nextCursor).toBeUndefined();
    const all = [...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.name);
    expect(new Set(all).size).toBe(450);
    expect(all).toContain("f000.txt");
    expect(all).toContain("f449.txt");
  });

  it("rejects a garbage cursor", async () => {
    const r = await s.call("list", { path: "big", cursor: "garbage" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^invalid/);
  });

  it("returns not_found for a missing folder", async () => {
    const r = await s.call("list", { path: "nope" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_found/);
  });

  it("refuses to list a file", async () => {
    const r = await s.call("list", { path: "hello.txt" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_a_folder/);
  });
});
