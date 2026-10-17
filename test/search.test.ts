import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, runServerExpectingExit, startServer, TEST_TOKEN, textOf, type TestServer } from "./harness.js";

interface NameHit {
  path: string;
  name: string;
  type: "file" | "folder" | "other";
}
interface LineHit {
  path: string;
  line: number;
  text: string;
}
interface SearchResult {
  entries?: NameHit[];
  matches?: LineHit[];
  truncated: boolean;
  skipped?: { path: string; reason: string }[];
}

const res = (r: any) => r.structuredContent as SearchResult;
const entryPaths = (r: any) => res(r).entries!.map((e) => e.path).sort();

describe("search", () => {
  let s: TestServer;
  beforeAll(async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 105; i++) many[`m/many/f${String(i).padStart(3, "0")}.log`] = "x\n";
    s = await startServer({
      layout: {
        ...many,
        // Just over the default 5 MB grep cap; the match is on line 1.
        "m/huge/big.txt": "needle\n" + "y".repeat(5 * 1024 * 1024),
        "m/huge/small.txt": "needle\n",
        "m/notes/plan.md": "first line\nbudget for 2026\nlast line\n",
        "m/notes/ideas.md": "nothing here\n",
        "m/notes/reports/": "",
        "m/reports/q1.txt": "Budget review\n",
      },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("finds files and folders by name glob", async () => {
    const r = await s.call("search", { name: "*.md" });
    expect(r.isError).toBeFalsy();
    expect(entryPaths(r)).toEqual(["m/notes/ideas.md", "m/notes/plan.md"]);
    expect(res(r).truncated).toBe(false);

    const folders = await s.call("search", { name: "reports" });
    expect(res(folders).entries).toEqual([
      expect.objectContaining({ path: "m/notes/reports", name: "reports", type: "folder" }),
      expect.objectContaining({ path: "m/reports", name: "reports", type: "folder" }),
    ]);
  });

  it("greps text file contents, returning Path, line number and line", async () => {
    const r = await s.call("search", { content: "budget" });
    expect(r.isError).toBeFalsy();
    expect(res(r).matches).toEqual([{ path: "m/notes/plan.md", line: 2, text: "budget for 2026" }]);
    expect(res(r).truncated).toBe(false);
  });

  it("greps case-insensitively when asked, and combines with the name glob", async () => {
    const all = await s.call("search", { content: "BUDGET", ignoreCase: true });
    expect(res(all).matches!.map((m) => m.path)).toEqual(["m/notes/plan.md", "m/reports/q1.txt"]);

    const txtOnly = await s.call("search", { content: "budget", ignoreCase: true, name: "*.txt" });
    expect(res(txtOnly).matches).toEqual([{ path: "m/reports/q1.txt", line: 1, text: "Budget review" }]);
  });

  it("restricts results to a sub-folder scope", async () => {
    const byName = await s.call("search", { name: "reports", path: "m/notes" });
    expect(entryPaths(byName)).toEqual(["m/notes/reports"]);

    const byContent = await s.call("search", { content: "budget", ignoreCase: true, path: "m/reports" });
    expect(res(byContent).matches!.map((m) => m.path)).toEqual(["m/reports/q1.txt"]);
  });

  it("reports a missing scope folder as not_found", async () => {
    const r = await s.call("search", { name: "*", path: "m/nope" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_found:/);
  });

  it("caps results at 100 by default and reports truncation", async () => {
    const r = await s.call("search", { name: "*.log" });
    expect(res(r).entries).toHaveLength(100);
    expect(res(r).truncated).toBe(true);

    const grep = await s.call("search", { content: "x", path: "m/many" });
    expect(res(grep).matches).toHaveLength(100);
    expect(res(grep).truncated).toBe(true);
  });

  it("skips files over the 5 MB grep cap and says so", async () => {
    const r = await s.call("search", { content: "needle", path: "m/huge" });
    expect(res(r).matches).toEqual([{ path: "m/huge/small.txt", line: 1, text: "needle" }]);
    expect(res(r).skipped).toEqual([{ path: "m/huge/big.txt", reason: "too_large" }]);
  });

  it("still finds over-cap files by name", async () => {
    const r = await s.call("search", { name: "big.txt" });
    expect(entryPaths(r)).toEqual(["m/huge/big.txt"]);
  });
});

describe("search with NAS_MCP_SEARCH_MAX_RESULTS", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "m/a.txt": "hit\nhit\n",
        "m/b.txt": "hit\n",
        "m/c.txt": "hit\n",
        "m/d.txt": "miss\n",
        "m/sized/at-cap.log": "hit" + "z".repeat(97), // exactly 100 bytes
        "m/sized/over-cap.log": "hit" + "z".repeat(98), // 101 bytes
      },
      env: { NAS_MCP_SEARCH_MAX_RESULTS: "3", NAS_MCP_GREP_MAX_FILE_BYTES: "100" },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("caps name results at the configured limit", async () => {
    const r = await s.call("search", { name: "*.txt" });
    expect(entryPaths(r)).toEqual(["m/a.txt", "m/b.txt", "m/c.txt"]);
    expect(res(r).truncated).toBe(true);
  });

  it("counts each matching line toward the limit", async () => {
    const r = await s.call("search", { content: "hit" });
    expect(res(r).matches).toEqual([
      { path: "m/a.txt", line: 1, text: "hit" },
      { path: "m/a.txt", line: 2, text: "hit" },
      { path: "m/b.txt", line: 1, text: "hit" },
    ]);
    expect(res(r).truncated).toBe(true);
  });

  it("does not report truncation when results exactly fill the limit", async () => {
    const exact = await s.call("search", { name: "[abc].txt" });
    expect(res(exact).entries).toHaveLength(3);
    expect(res(exact).truncated).toBe(false);
  });

  it("uses NAS_MCP_GREP_MAX_FILE_BYTES as the grep cap", async () => {
    const r = await s.call("search", { content: "hit", path: "m/sized" });
    expect(res(r).matches!.map((m) => m.path)).toEqual(["m/sized/at-cap.log"]);
    expect(res(r).skipped).toEqual([{ path: "m/sized/over-cap.log", reason: "too_large" }]);
  });
});

describe("search and Hidden Entries", () => {
  let s: TestServer;
  let outside: string;
  beforeAll(async () => {
    outside = await makeTempDir("nas-mcp-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    s = await startServer({
      layout: {
        "m/visible/secret.txt": "secret\n",
        "m/visible/@eaDir/secret.txt": "secret\n",
        "m/visible/.DS_Store": "secret\n",
        "m/.nas-mcp-trash/2026-01-01/secret.txt": "secret\n",
        "m/#recycle/secret.txt": "secret\n",
        "m/private/secret.txt": "secret\n",
        "m/visible/blob.bin": Buffer.from("secret\n\0\0\0binary"),
      },
      setup: async (root) => {
        await symlink(outside, path.join(root, "m/visible", "escape"));
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "private", NAS_MCP_TRASH_RETENTION_DAYS: "0" },
    });
  });
  afterAll(async () => {
    await s.stop();
    await rm(outside, { recursive: true, force: true });
  });

  it("never returns Hidden Entries or out-of-Root symlinks by name", async () => {
    const r = await s.call("search", { name: "*" });
    expect(entryPaths(r)).toEqual(["m", "m/visible", "m/visible/blob.bin", "m/visible/secret.txt"]);
    const byName = await s.call("search", { name: "secret.txt" });
    expect(entryPaths(byName)).toEqual(["m/visible/secret.txt"]);
  });

  it("never greps Hidden Entries, out-of-Root symlinks, or binary files", async () => {
    const r = await s.call("search", { content: "secret" });
    expect(res(r).matches).toEqual([{ path: "m/visible/secret.txt", line: 1, text: "secret" }]);
  });

  it("refuses a Hidden Entry as the scope", async () => {
    for (const scope of ["m/.nas-mcp-trash", "m/private", "m/visible/@eaDir"]) {
      const r = await s.call("search", { content: "secret", path: scope });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^forbidden:/);
    }
  });
});

describe.concurrent("search config", () => {
  it.each([
    ["NAS_MCP_SEARCH_MAX_RESULTS", "0"],
    ["NAS_MCP_SEARCH_MAX_RESULTS", "lots"],
    ["NAS_MCP_GREP_MAX_FILE_BYTES", "-1"],
  ])("refuses to start when %s=%s", async (name, value) => {
    const root = await makeTempDir();
    try {
      const { code, stderr } = await runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: TEST_TOKEN, [name]: value });
      expect(code).not.toBe(0);
      expect(stderr).toContain(name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
