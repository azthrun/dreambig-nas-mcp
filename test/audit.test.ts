import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, textOf, type TestServer } from "./harness.js";

/** Every write / Destructive Operation call is audited, including ones that fail. */
describe("audit log for failed write and Destructive Operation calls", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: { "m/a.txt": "same same", "m/b.txt": "b", "m/file/": "", "m/f.txt": "f" },
    });
  });
  afterAll(() => s.stop());

  const cases: [string, Record<string, unknown>, string, string[]][] = [
    ["write", { path: "m/a.txt", content: "x" }, "exists", ["m/a.txt"]],
    ["edit", { path: "m/a.txt", oldString: "nope", newString: "x" }, "no_match", ["m/a.txt"]],
    ["edit", { path: "m/a.txt", oldString: "same", newString: "x" }, "not_unique", ["m/a.txt"]],
    ["edit", { path: "m/missing.txt", oldString: "a", newString: "b" }, "not_found", ["m/missing.txt"]],
    ["mkdir", { path: "m/f.txt" }, "exists", ["m/f.txt"]],
    ["move", { from: "m/missing.txt", to: "m/x.txt" }, "not_found", ["m/missing.txt"]],
    ["move", { from: "m/b.txt", to: "m/a.txt" }, "exists", ["m/a.txt"]],
    ["delete", { path: "m/missing.txt" }, "not_found", ["m/missing.txt"]],
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
    const r = await s.call("read", { path: "m/missing.txt" });
    expect(textOf(r)).toMatch(/^not_found:/);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.auditLines().filter((l) => l.tool === "read")).toEqual([]);
  });
});
