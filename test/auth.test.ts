import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type TestServer } from "./harness.js";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

function postMcp(url: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(initialize),
  });
}

describe("auth", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(async () => {
    await s.stop();
  });

  it("serves /healthz without a token", async () => {
    const res = await fetch(`${s.baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("rejects /mcp with no token (401) and audits it", async () => {
    const res = await postMcp(s.mcpUrl);
    expect(res.status).toBe(401);
    const line = await s.waitForAudit((l) => l.reason === "unauthorized");
    expect(line.result).toBe("rejected");
    expect(typeof line.time).toBe("string");
  });

  it("rejects /mcp with a wrong token (401)", async () => {
    const res = await postMcp(s.mcpUrl, { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const res = await postMcp(s.mcpUrl, { authorization: "Bearer test-token" });
    expect(res.status).toBe(401);
  });

  it("accepts the correct token and lists the tools with readOnlyHint", async () => {
    const { tools } = await s.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list?.annotations?.readOnlyHint).toBe(true);
    expect(byName.stat?.annotations?.readOnlyHint).toBe(true);
  });
});
