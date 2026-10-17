/**
 * Integration test harness: the single test seam (MCP over HTTP).
 *
 * Starts the real server as a child process against a fresh temporary Root,
 * connects the official MCP SDK client over Streamable HTTP, and captures
 * stdout so tests can assert on audit-log lines.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "dist", "index.js"); // built by test/global-setup.ts

export const TEST_TOKEN = "test-token-0123456789";

/** Files to create in the Root: Path (including the Mount, e.g. "m/notes/x.md") -> contents. Paths ending in "/" become folders. */
export type RootLayout = Record<string, string | Buffer>;

export async function makeTempDir(prefix = "nas-mcp-root-"): Promise<string> {
  // realpath: macOS tmpdir is behind a /var -> /private/var symlink.
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

export async function populate(root: string, layout: RootLayout): Promise<void> {
  for (const [rel, contents] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    if (rel.endsWith("/")) {
      await mkdir(abs, { recursive: true });
    } else {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, contents);
    }
  }
}

export interface AuditLine {
  type: "audit";
  time: string;
  result: string;
  [key: string]: unknown;
}

/** Spawn the server process with the given NAS_MCP_* env (any inherited NAS_MCP_* vars are dropped). */
function spawnServer(env: Record<string, string | undefined>): ChildProcess {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NAS_MCP_")));
  return spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Run the server expecting it to refuse to start. Resolves with its exit code and stderr.
 */
export async function runServerExpectingExit(
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawnServer({ NAS_MCP_PORT: "0", ...env });
  let stderr = "";
  let stdout = "";
  child.stderr!.on("data", (d) => (stderr += d));
  child.stdout!.on("data", (d) => (stdout += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  return { code, stderr, stdout };
}

export interface TestServer {
  /** Absolute (real) path of the temporary Root. */
  root: string;
  /** Base URL, e.g. http://127.0.0.1:12345 */
  baseUrl: string;
  /** MCP endpoint URL. */
  mcpUrl: string;
  /** MCP client connected with the correct token. */
  client: Client;
  /** Call a tool through the MCP client. */
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** All stdout lines so far, parsed as JSON where possible. */
  stdoutLines(): unknown[];
  /** Audit lines emitted so far. */
  auditLines(): AuditLine[];
  /** Wait until an audit line matching the predicate shows up (stdout is async). */
  waitForAudit(pred: (line: AuditLine) => boolean, timeoutMs?: number): Promise<AuditLine>;
  stop(): Promise<void>;
}

/** The Mount every test gets unless it asks for others. */
export const DEFAULT_MOUNT = "m";

export interface StartOptions {
  /**
   * Mount folders to create at the top of the fresh Root (default `[DEFAULT_MOUNT]`).
   * Plain folders, not real mount points: the harness sets NAS_MCP_REQUIRE_MOUNT_POINTS=false.
   */
  mounts?: string[];
  /** Files/folders to create in the fresh Root before starting. */
  layout?: RootLayout;
  /** Hook to prepare the Root (e.g. create symlinks) before the server starts. */
  setup?: (root: string) => Promise<void>;
  /** Extra env vars (override defaults). */
  env?: Record<string, string | undefined>;
}

/** Start the real server against a fresh temporary Root and connect an MCP client. */
export async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  const root = await makeTempDir();
  for (const m of opts.mounts ?? [DEFAULT_MOUNT]) await mkdir(path.join(root, m), { recursive: true });
  if (opts.layout) await populate(root, opts.layout);
  if (opts.setup) await opts.setup(root);

  const child = spawnServer({
    NAS_MCP_ROOT: root,
    NAS_MCP_TOKEN: TEST_TOKEN,
    NAS_MCP_PORT: "0",
    NAS_MCP_HOST: "127.0.0.1",
    NAS_MCP_REQUIRE_MOUNT_POINTS: "false",
    ...opts.env,
  });

  const lines: string[] = [];
  let stderr = "";
  let buf = "";
  const listeners = new Set<() => void>();
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    for (const l of listeners) l();
  });
  child.stderr!.on("data", (d) => (stderr += d));

  const parsed = () =>
    lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return l;
      }
    });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${stderr}`)), 45_000);
    const check = () => {
      for (const l of parsed()) {
        if (l && typeof l === "object" && (l as any).type === "listening") {
          clearTimeout(timer);
          listeners.delete(check);
          resolve((l as any).port);
        }
      }
    };
    listeners.add(check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}):\n${stderr}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    }),
  );

  const auditLines = () =>
    parsed().filter((l): l is AuditLine => !!l && typeof l === "object" && (l as any).type === "audit");

  return {
    root,
    baseUrl,
    mcpUrl,
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    stdoutLines: parsed,
    auditLines,
    waitForAudit(pred, timeoutMs = 3_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = auditLines().find(pred);
          if (hit) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(hit);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`no matching audit line; stdout:\n${lines.join("\n")}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
    },
    async stop() {
      await client.close().catch(() => {});
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await exited;
      }
      await chmodTree(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Make every folder under `dir` writable again (tests make Mounts read-only with chmod), so it can be removed. */
export async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => {});
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory()) await chmodTree(path.join(dir, e.name));
}

/** Text of the first text content block of a tool result. */
export function textOf(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}
