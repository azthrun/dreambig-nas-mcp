/**
 * Trash purge (#8, ADR-0001): entries are aged by the dated Trash folder they
 * sit in (`<trash>/<YYYY-MM-DD>/...`, the day they were trashed), not by their
 * own mtime (rename keeps the mtime of the original file). Tests "backdate"
 * entries by placing them in past-dated folders; no clock is injected.
 */
import { existsSync } from "node:fs";
import { rm, utimes } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, populate, runServerExpectingExit, startServer, TEST_TOKEN, type TestServer } from "./harness.js";
import { allEntries, TRASH_DIR } from "./trash-helpers.js";

/** Trash date folder name for `daysAgo` days before today (local time, like the server). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const t = (rel: string) => `${TRASH_DIR}/${rel}`;

describe("purge at startup with default retention (30 days)", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "notes/keep.md": "live file",
        [t(`${daysAgo(31)}/notes/old.md`)]: "old",
        [t(`${daysAgo(400)}/photos/`)]: "",
        [t(`${daysAgo(30)}/notes/edge.md`)]: "30 days",
        [t(`${daysAgo(0)}/notes/today.md`)]: "today",
      },
      setup: async (root) => {
        // An ancient file trashed today must survive: age comes from the folder, not the mtime.
        const ancient = new Date("2000-01-01T00:00:00Z");
        await utimes(path.join(root, t(`${daysAgo(0)}/notes/today.md`)), ancient, ancient);
      },
    });
  });
  afterAll(() => s.stop());

  it("removes Trash entries older than 30 days", () => {
    expect(existsSync(path.join(s.root, t(daysAgo(31))))).toBe(false);
    expect(existsSync(path.join(s.root, t(daysAgo(400))))).toBe(false);
  });

  it("keeps entries 30 days old or newer, whatever their mtime", async () => {
    expect(await allEntries(path.join(s.root, TRASH_DIR))).toEqual([
      daysAgo(30),
      `${daysAgo(30)}/notes`,
      `${daysAgo(30)}/notes/edge.md`,
      daysAgo(0),
      `${daysAgo(0)}/notes`,
      `${daysAgo(0)}/notes/today.md`,
    ].sort());
  });

  it("never touches files outside the Trash", () => {
    expect(existsSync(path.join(s.root, "notes/keep.md"))).toBe(true);
  });

  it("logs an audit line listing what was purged", async () => {
    const line = await s.waitForAudit((l) => l.action === "trash_purge");
    expect(line.result).toBe("ok");
    expect([...(line.purged as string[])].sort()).toEqual([daysAgo(31), daysAgo(400)].sort());
  });
});

describe("retention 0 keeps everything", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: { [t(`${daysAgo(5000)}/notes/ancient.md`)]: "ancient" },
      env: { NAS_MCP_TRASH_RETENTION_DAYS: "0", NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS: "1" },
    });
  });
  afterAll(() => s.stop());

  it("never purges, at startup or later", async () => {
    await new Promise((r) => setTimeout(r, 1500)); // past one would-be interval
    expect(existsSync(path.join(s.root, t(`${daysAgo(5000)}/notes/ancient.md`)))).toBe(true);
    expect(s.auditLines().filter((l) => l.action === "trash_purge")).toEqual([]);
  });
});

describe("periodic purge while running", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ env: { NAS_MCP_TRASH_RETENTION_DAYS: "7", NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS: "1" } });
  });
  afterAll(() => s.stop());

  it("purges entries that appear after startup on the next interval", async () => {
    await populate(s.root, {
      [t(`${daysAgo(8)}/a.md`)]: "old",
      [t(`${daysAgo(7)}/b.md`)]: "kept",
    });
    const line = await s.waitForAudit((l) => l.action === "trash_purge" && (l.purged as string[]).length > 0, 5_000);
    expect(line.purged).toEqual([daysAgo(8)]);
    expect(await allEntries(path.join(s.root, TRASH_DIR))).toEqual([daysAgo(7), `${daysAgo(7)}/b.md`]);
  });
});

describe("retention config", () => {
  it("refuses to start with an invalid retention", async () => {
    const root = await makeTempDir();
    try {
      const r = await runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: TEST_TOKEN, NAS_MCP_TRASH_RETENTION_DAYS: "-1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("NAS_MCP_TRASH_RETENTION_DAYS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
