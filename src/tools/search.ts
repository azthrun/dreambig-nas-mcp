/**
 * search: name glob + optional streaming content grep. No index; one walk per
 * call, lines streamed so memory stays flat on the NAS. Hidden Entries are
 * never visited (the walk goes through `sandbox.children`).
 */
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { detectKind } from "../content-kind.js";
import { entryType, type Child, type Resolved, type Sandbox } from "../sandbox.js";
import { defineTool, structured } from "./types.js";

/** Matching lines longer than this are cut, so one minified file can't flood the agent's context. */
const MAX_LINE_CHARS = 500;

const entrySchema = z.object({
  path: z.string().describe("Root-relative Path"),
  name: z.string(),
  type: z.enum(["file", "folder", "other"]),
  size: z.number().describe("Bytes (0 for folders)"),
  modified: z.string().describe("ISO 8601"),
});
type Entry = z.infer<typeof entrySchema>;

const matchSchema = z.object({
  path: z.string().describe("Root-relative Path"),
  line: z.number().describe("1-based line number"),
  text: z.string().describe(`The matching line (cut at ${MAX_LINE_CHARS} characters)`),
});
type Match = z.infer<typeof matchSchema>;

/** Pre-order walk of visible entries below `dir`. In-Root symlinked folders are followed once (loop-safe). */
async function* walk(sandbox: Sandbox, dir: Resolved, seen = new Set<string>([dir.real])): AsyncGenerator<Child> {
  for (const child of await sandbox.children(dir)) {
    yield child;
    if (child.stats.isDirectory() && !seen.has(child.real)) {
      seen.add(child.real);
      yield* walk(sandbox, child, seen);
    }
  }
}

/** Stream a text file line by line, yielding matching lines. */
async function* grepFile(file: Child, needle: string, ignoreCase: boolean): AsyncGenerator<Match> {
  const stream = createReadStream(file.real, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let n = 0;
    for await (const line of lines) {
      n++;
      const hay = ignoreCase ? line.toLowerCase() : line;
      if (hay.includes(needle)) yield { path: file.path, line: n, text: line.slice(0, MAX_LINE_CHARS) };
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export const searchTool = defineTool({
  name: "search",
  title: "Search files",
  description:
    "Find files and folders inside the Root by name glob, and optionally grep UTF-8 text files for a literal string " +
    "(returns Path, line number and line). Optionally limited to a sub-folder. Results are capped; truncated=true means " +
    "there were more, so narrow the search. Content search skips files over the grep size cap (listed in skipped).",
  inputSchema: {
    name: z.string().default("*").describe('Name glob, e.g. "*.md" or "report-202?-*". Default "*".'),
    content: z
      .string()
      .min(1)
      .optional()
      .describe("Literal text to look for inside UTF-8 text files whose name matches `name`. Omit for a name-only search."),
    ignoreCase: z.boolean().default(false).describe("Case-insensitive content match"),
    path: z.string().default("").describe('Root-relative folder to search in, e.g. "notes/2026". Empty for the whole Root.'),
  },
  outputSchema: {
    entries: z.array(entrySchema).optional().describe("Name-search results (when `content` is omitted)"),
    matches: z.array(matchSchema).optional().describe("Content-search results (when `content` is given)"),
    truncated: z.boolean().describe("True if more results exist than were returned; narrow the search"),
    skipped: z
      .array(z.object({ path: z.string(), reason: z.enum(["too_large"]) }))
      .optional()
      .describe("Content search only: files whose name matched but that were too large to grep (up to the result limit)"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ name, content, ignoreCase, path: scopePath }, { sandbox, config }) {
    const limit = config.searchMaxResults;
    const scope = await sandbox.resolve(scopePath);

    if (content === undefined) {
      const entries: Entry[] = [];
      for await (const c of walk(sandbox, scope)) {
        if (!path.matchesGlob(c.name, name)) continue;
        if (entries.length === limit) return structured({ entries, truncated: true });
        entries.push({
          path: c.path,
          name: c.name,
          type: entryType(c.stats),
          size: c.stats.isFile() ? c.stats.size : 0,
          modified: c.stats.mtime.toISOString(),
        });
      }
      return structured({ entries, truncated: false });
    }

    const needle = ignoreCase ? content.toLowerCase() : content;
    const matches: Match[] = [];
    const skipped: { path: string; reason: "too_large" }[] = [];
    for await (const c of walk(sandbox, scope)) {
      if (!c.stats.isFile() || !path.matchesGlob(c.name, name)) continue;
      if (c.stats.size > config.grepMaxFileBytes) {
        if (skipped.length < limit) skipped.push({ path: c.path, reason: "too_large" });
        continue;
      }
      if ((await detectKind(c.real)).kind !== "text") continue;
      for await (const m of grepFile(c, needle, ignoreCase)) {
        if (matches.length === limit) return structured({ matches, truncated: true, skipped });
        matches.push(m);
      }
    }
    return structured({ matches, truncated: false, skipped });
  },
});
