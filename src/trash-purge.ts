/**
 * Trash purge (ADR-0001): permanently removes Trash entries older than the
 * retention period, at startup and then on an interval.
 *
 * Entries are aged by the dated folder they sit in (`<trash>/<YYYY-MM-DD>/`,
 * the day they were trashed, server local time), never by their own mtime:
 * trashing is a rename, so an old file trashed today keeps its old mtime.
 * A date folder is purged once it is more than `retentionDays` days old, so
 * every entry is kept for at least `retentionDays` full days. Anything in the
 * Trash that is not a date folder is left alone.
 */
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { audit } from "./audit.js";
import type { Config } from "./config.js";

const DATE_FOLDER = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between the local calendar date of `now` and the date folder `name`; null if not a date folder. */
function ageInDays(name: string, now: Date): number | null {
  const m = DATE_FOLDER.exec(name);
  if (!m) return null;
  const folder = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - folder) / DAY_MS);
}

/**
 * Run one purge. Emits one audit line (`action: "trash_purge"`) listing the
 * purged date folders as Trash-relative Paths. Never throws.
 */
export async function purgeTrash(config: Config, now: Date = new Date()): Promise<void> {
  if (config.trashRetentionDays === 0) return;
  const dir = path.join(config.root, config.trashDirName);
  const purged: string[] = [];
  try {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") entries = [];
      else throw err;
    }
    for (const e of entries) {
      const age = ageInDays(e.name, now);
      if (!e.isDirectory() || age === null || age <= config.trashRetentionDays) continue;
      await rm(path.join(dir, e.name), { recursive: true, force: true });
      purged.push(e.name);
    }
    audit({ result: "ok", action: "trash_purge", purged });
  } catch (err) {
    audit({ result: "error", action: "trash_purge", purged, message: (err as Error).message });
  }
}

/**
 * Purge once now (awaited, so startup purge finishes before the server
 * listens), then every `trashPurgeIntervalSeconds`. Returns a stop function.
 */
export async function startTrashPurge(config: Config): Promise<() => void> {
  if (config.trashRetentionDays === 0) return () => {};
  await purgeTrash(config);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await purgeTrash(config);
    } finally {
      running = false;
    }
  }, config.trashPurgeIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
