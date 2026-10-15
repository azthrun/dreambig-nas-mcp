import { z } from "zod";
import { ToolError } from "../errors.js";
import type { Resolved, Sandbox } from "../sandbox.js";
import { entrySchema, toEntry, type Entry } from "./entry.js";
import { defineTool, structured } from "./types.js";

export const PAGE_SIZE = 200;
export const MAX_DEPTH = 3;

interface CursorData {
  p: string;
  d: number;
  o: number;
}

const encodeCursor = (c: CursorData) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decodeCursor(cursor: string, rel: string, depth: number): number {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorData;
    if (c.p === rel && c.d === depth && Number.isInteger(c.o) && c.o > 0) return c.o;
  } catch {
    // fall through
  }
  throw new ToolError("invalid", "cursor is not valid for this path and depth; start again without a cursor");
}

/** Pre-order walk. In-Root symlinked folders are followed; MAX_DEPTH bounds symlink loops. */
async function walk(sandbox: Sandbox, dir: Resolved, depth: number, out: Entry[]): Promise<void> {
  for (const child of await sandbox.children(dir)) {
    out.push(toEntry(child));
    if (depth > 1 && child.stats.isDirectory()) {
      await walk(sandbox, child, depth - 1, out);
    }
  }
}

export const listTool = defineTool({
  name: "list",
  title: "List folder",
  description:
    `List a folder inside the Root. One level deep by default; set depth (max ${MAX_DEPTH}) to include sub-folders. ` +
    `Returns up to ${PAGE_SIZE} entries per call; if nextCursor is present, call again with the same path, depth and that cursor.`,
  inputSchema: {
    path: z.string().default("").describe('Root-relative folder Path, e.g. "notes/2026". Empty for the Root.'),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1).describe(`Levels to descend (1-${MAX_DEPTH})`),
    cursor: z.string().optional().describe("nextCursor from a previous call"),
  },
  outputSchema: {
    path: z.string(),
    entries: z.array(entrySchema),
    nextCursor: z.string().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ path, depth, cursor }, { sandbox }) {
    const dir = await sandbox.resolve(path);
    const offset = cursor ? decodeCursor(cursor, dir.path, depth) : 0;
    const all: Entry[] = [];
    await walk(sandbox, dir, depth, all);
    const entries = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE;
    return structured({
      path: dir.path,
      entries,
      ...(next < all.length ? { nextCursor: encodeCursor({ p: dir.path, d: depth, o: next }) } : {}),
    });
  },
});
