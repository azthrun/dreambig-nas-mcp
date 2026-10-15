import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { startServer, type TestServer } from "./harness.js";

const exists = (p: string) => access(p).then(() => true, () => false);

/** Temp files left behind by an interrupted atomic write are removed (and audited) at startup. */
describe("leftover temp files", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "notes/plan.md": "plan",
        "notes/.plan.md.nas-mcp-tmp-0123456789ab": "half-written",
        ".top.txt.nas-mcp-tmp-abcdef012345": "half",
        "notes/.keep.nas-mcp-tmp-notours": "not a temp file name we generate",
        "notes/regular.nas-mcp-tmp-0123456789ab": "no leading dot",
      },
      env: { NAS_MCP_TRASH_RETENTION_DAYS: "0" },
    });
  });
  afterAll(() => s.stop());

  it("removes them at startup and writes one audit line listing them", async () => {
    const line = await s.waitForAudit((l) => l.action === "temp_cleanup");
    expect(line.result).toBe("ok");
    expect((line.removed as string[]).sort()).toEqual([".top.txt.nas-mcp-tmp-abcdef012345", "notes/.plan.md.nas-mcp-tmp-0123456789ab"]);
    expect(await exists(path.join(s.root, "notes/.plan.md.nas-mcp-tmp-0123456789ab"))).toBe(false);
    expect(await exists(path.join(s.root, ".top.txt.nas-mcp-tmp-abcdef012345"))).toBe(false);
  });

  it("leaves real files alone", async () => {
    await s.waitForAudit((l) => l.action === "temp_cleanup");
    expect(await readFile(path.join(s.root, "notes/plan.md"), "utf8")).toBe("plan");
    expect(await exists(path.join(s.root, "notes/.keep.nas-mcp-tmp-notours"))).toBe(true);
    expect(await exists(path.join(s.root, "notes/regular.nas-mcp-tmp-0123456789ab"))).toBe(true);
  });
});
