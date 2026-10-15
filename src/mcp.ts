/**
 * Builds an McpServer with every tool from `tools/index.ts` registered,
 * wrapping handlers so ToolErrors become MCP tool errors (and rejections are audited).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { audit } from "./audit.js";
import type { Config } from "./config.js";
import { ToolError } from "./errors.js";
import { Sandbox } from "./sandbox.js";
import { tools } from "./tools/index.js";
import { Trash } from "./trash.js";
import type { ToolContext } from "./tools/types.js";

export const SERVER_NAME = "dreambig-nas-mcp";
export const SERVER_VERSION = "0.1.0";

function toolError(err: ToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${err.code}: ${err.message}` }] };
}

export function createMcpServer(config: Config): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx: ToolContext = { config, sandbox: new Sandbox(config), trash: new Trash(config) };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      (async (args: any) => {
        try {
          return await tool.handler(args, ctx);
        } catch (err) {
          if (err instanceof ToolError) {
            if (err.code === "forbidden") {
              audit({ result: "rejected", tool: tool.name, paths: err.paths, reason: err.code, message: err.message });
            }
            return toolError(err);
          }
          throw err;
        }
      }) as any,
    );
  }
  return server;
}
