/**
 * HTTP layer: `/healthz` (open) and `/mcp` (bearer token, stateless Streamable HTTP).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { audit, logInfo } from "./audit.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time check of the `Authorization: Bearer <token>` header. */
function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  // Hash both sides so lengths match and timing does not leak the token length.
  return timingSafeEqual(digest(match ? match[1].trim() : ""), expected) && !!match;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function handleMcp(config: Config, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream (GET) and no sessions to DELETE.
    res.setHeader("allow", "POST");
    return jsonRpcError(res, 405, "Method not allowed");
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonRpcError(res, 400, `Bad request: ${(err as Error).message}`);
  }
  // Stateless: a fresh server + transport per request.
  const server = createMcpServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function startHttpServer(config: Config): Promise<http.Server> {
  const expected = digest(config.token);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { status: "ok" });
      }
      if (url.pathname === "/mcp") {
        if (!isAuthorized(req, expected)) {
          audit({ result: "rejected", reason: "unauthorized", message: `${req.method} /mcp from ${req.socket.remoteAddress}` });
          return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="nas-mcp"' });
        }
        return await handleMcp(config, req, res);
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("Request failed:", err);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;
  logInfo("listening", { host: config.host, port, root: config.root });
  return server;
}
