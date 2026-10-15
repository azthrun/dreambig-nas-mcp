import { describe, it, expect, afterAll } from "vitest";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { makeTempDir, runServerExpectingExit, TEST_TOKEN } from "./harness.js";

describe.concurrent("startup config", () => {
  const cleanup: string[] = [];
  afterAll(async () => {
    for (const dir of cleanup.splice(0)) {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start when the token is unset", async () => {
    const root = await makeTempDir();
    cleanup.push(root);
    const { code, stderr } = await runServerExpectingExit({ NAS_MCP_ROOT: root });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/NAS_MCP_TOKEN/);
  });

  it("refuses to start with the .env.example placeholder token", async () => {
    const root = await makeTempDir();
    cleanup.push(root);
    const { code, stderr } = await runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: "change-me" });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/NAS_MCP_TOKEN/);
    expect(stderr).toMatch(/placeholder/i);
  });

  it("refuses to start with a token shorter than 16 characters", async () => {
    const root = await makeTempDir();
    cleanup.push(root);
    const { code, stderr } = await runServerExpectingExit({ NAS_MCP_ROOT: root, NAS_MCP_TOKEN: "short-token-123" });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/NAS_MCP_TOKEN/);
    expect(stderr).toMatch(/16/);
  });

  it("refuses to start when the Root is unset", async () => {
    const { code, stderr } = await runServerExpectingExit({ NAS_MCP_TOKEN: TEST_TOKEN });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/NAS_MCP_ROOT/);
  });

  it("refuses to start when the Root does not exist", async () => {
    const parent = await makeTempDir();
    cleanup.push(parent);
    const missing = path.join(parent, "nope");
    const { code, stderr } = await runServerExpectingExit({
      NAS_MCP_ROOT: missing,
      NAS_MCP_TOKEN: TEST_TOKEN,
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/NAS_MCP_ROOT/);
    expect(stderr).toContain(missing);
  });

  it.skipIf(process.getuid?.() === 0)("refuses to start when the Root is unreadable", async () => {
    const root = await makeTempDir();
    cleanup.push(root);
    await chmod(root, 0o000);
    const { code, stderr } = await runServerExpectingExit({
      NAS_MCP_ROOT: root,
      NAS_MCP_TOKEN: TEST_TOKEN,
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/NAS_MCP_ROOT/);
    expect(stderr).toMatch(/not readable/i);
  });
});
