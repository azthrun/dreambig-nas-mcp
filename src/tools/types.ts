import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Config } from "../config.js";
import type { Sandbox } from "../sandbox.js";

/** Everything a tool handler may use. Add shared modules (e.g. Trash) here. */
export interface ToolContext {
  config: Config;
  sandbox: Sandbox;
}

export interface ToolDefinition<In extends z.ZodRawShape = z.ZodRawShape, Out extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: In;
  /** If set, the handler must return `structuredContent` matching it. */
  outputSchema?: Out;
  /** readOnlyHint for read tools; destructiveHint for Destructive Operations. */
  annotations: ToolAnnotations;
  handler(args: z.infer<z.ZodObject<In>>, ctx: ToolContext): Promise<CallToolResult>;
}

/** Identity helper that gives handlers typed args. */
export function defineTool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(
  def: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  return def;
}

/** Result with both structured content and a JSON text copy (for clients that ignore structuredContent). */
export function structured(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}
