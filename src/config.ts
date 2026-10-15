/**
 * Config: reads and validates env vars once at startup; fails fast.
 *
 * To add a setting: add a field to `Config`, parse it in `loadConfig` with the
 * helpers below, and list it in `.env.example`.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";

export interface Config {
  /** Real absolute path of the Root. */
  root: string;
  /** Bearer token required on every /mcp request. */
  token: string;
  /** Listen port (container port; default 8080; 0 = pick a free port). */
  port: number;
  /** Listen address. */
  host: string;
  /** Name of the Trash folder at the top of the Root (a Hidden Entry). */
  trashDirName: string;
  /** Extra Hidden Entry glob patterns from NAS_MCP_HIDDEN_PATTERNS. */
  extraHiddenPatterns: string[];
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is not set`);
  return v;
}

function int(env: Env, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateRoot(raw: string): string {
  let st;
  try {
    st = statSync(raw);
  } catch {
    throw new ConfigError(`NAS_MCP_ROOT does not exist: ${raw}`);
  }
  if (!st.isDirectory()) throw new ConfigError(`NAS_MCP_ROOT is not a directory: ${raw}`);
  try {
    accessSync(raw, constants.R_OK | constants.X_OK);
  } catch {
    throw new ConfigError(`NAS_MCP_ROOT is not readable: ${raw}`);
  }
  return realpathSync(raw);
}

export function loadConfig(env: Env = process.env): Config {
  const token = required(env, "NAS_MCP_TOKEN");
  const root = validateRoot(required(env, "NAS_MCP_ROOT"));
  return {
    root,
    token,
    port: int(env, "NAS_MCP_PORT", 8080, 0, 65535),
    host: env.NAS_MCP_HOST?.trim() || "0.0.0.0",
    trashDirName: ".nas-mcp-trash",
    extraHiddenPatterns: list(env, "NAS_MCP_HIDDEN_PATTERNS"),
  };
}
