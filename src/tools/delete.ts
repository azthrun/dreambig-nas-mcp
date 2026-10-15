import { z } from "zod";
import { audit } from "../audit.js";
import { defineTool, structured } from "./types.js";

export const deleteTool = defineTool({
  name: "delete",
  title: "Delete file or folder",
  description:
    "Delete a file or folder (with its contents) inside the Root. Nothing is destroyed: the entry is moved to the " +
    "Trash, where the NAS owner can recover it until it is purged.",
  inputSchema: {
    path: z.string().describe('Root-relative Path of the file or folder, e.g. "notes/old.md"'),
  },
  outputSchema: {
    path: z.string().describe("The deleted Path (now in the Trash)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async handler({ path: input }, { sandbox, trash }) {
    const entry = await sandbox.resolveEntry(input);
    const trashedAt = await trash.moveToTrash({ path: entry.atPath, abs: entry.at });
    audit({ result: "ok", tool: "delete", paths: [entry.path], trashed: [trashedAt] });
    return structured({ path: entry.path });
  },
});
