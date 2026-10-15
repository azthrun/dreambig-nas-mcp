/**
 * The single list of tools. To add a tool: create `src/tools/<name>.ts`
 * exporting a `defineTool(...)`, import it here, and append it to `tools`
 * (one line each, to keep parallel merges trivial).
 */
import { listTool } from "./list.js";
import { statTool } from "./stat.js";
import { searchTool } from "./search.js";
import type { ToolDefinition } from "./types.js";

export const tools: ToolDefinition<any, any>[] = [
  listTool,
  statTool,
  searchTool,
];
