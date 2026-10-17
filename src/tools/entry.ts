/** The entry shape `list` and `search` report, shared so both stay in sync. */
import { z } from "zod";
import { entryType, type Child } from "../sandbox.js";

export const entrySchema = z.object({
  path: z.string().describe("Root-relative Path"),
  name: z.string(),
  type: z.enum(["file", "folder", "other"]),
  size: z.number().describe("Bytes (0 for folders)"),
  modified: z.string().describe("ISO 8601"),
  readOnly: z.boolean().optional().describe("True on a read-only Mount: nothing inside it can be changed"),
});
export type Entry = z.infer<typeof entrySchema>;

export function toEntry(c: Child): Entry {
  return {
    path: c.path,
    name: c.name,
    type: entryType(c.stats),
    size: c.stats.isFile() ? c.stats.size : 0,
    modified: c.stats.mtime.toISOString(),
    ...(c.readOnly ? { readOnly: true } : {}),
  };
}
