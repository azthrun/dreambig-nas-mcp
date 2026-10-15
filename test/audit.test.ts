import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, textOf, type TestServer } from "./harness.js";

/** Every write / Destructive Operation call is audited, including ones that fail. */
describe("audit log for failed write and Destructive Operation calls", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: { "a.txt": "same same", "b.txt": "b", "file/": "", "f.txt": "f" },
    });
  });
  afterAll(() => s.stop());

  const cases: [string, Record<string, unknown>, string, string[]][] = [
    ["write", { path: "a.txt", content: "x" }, "exists", ["a.txt"]],
    ["edit", { path: "a.txt", oldString: "nope", newString: "x" }, "no_match", ["a.txt"]],
    ["edit", { path: "a.txt", oldString: "same", newString: "x" }, "not_unique", ["a.txt"]],
    ["edit", { path: "missing.txt", oldString: "a", newString: "b" }, "not_found", ["missing.txt"]],
    ["mkdir", { path: "f.txt" }, "exists", ["f.txt"]],
    ["move", { from: "missing.txt", to: "x.txt" }, "not_found", ["missing.txt"]],
    ["move", { from: "b.txt", to: "a.txt" }, "exists", ["a.txt"]],
    ["delete", { path: "missing.txt" }, "not_found", ["missing.txt"]],
  ];

  for (const [tool, args, code, paths] of cases) {
    it(`${tool} failing with ${code} writes one error audit line`, async () => {
      const r = await s.call(tool, args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(new RegExp(`^${code}:`));
      const want = JSON.stringify(paths);
      const line = await s.waitForAudit((l) => l.tool === tool && l.reason === code && JSON.stringify(l.paths) === want);
      expect(line).toMatchObject({ result: "error", tool, reason: code, paths });
      expect(typeof line.message).toBe("string");
    });
  }

  it("does not audit failed read-only calls", async () => {
    const r = await s.call("read", { path: "missing.txt" });
    expect(textOf(r)).toMatch(/^not_found:/);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.auditLines().filter((l) => l.tool === "read")).toEqual([]);
  });
});
