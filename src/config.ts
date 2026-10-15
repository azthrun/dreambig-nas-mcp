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
  /** Max bytes `read` returns for text (whole file or one offset/limit part) and max PDF file size. */
  readTextMaxBytes: number;
  /** Max image file size `read` returns. */
  readImageMaxBytes: number;
  /** search: max results per call (NAS_MCP_SEARCH_MAX_RESULTS, default 100). */
  searchMaxResults: number;
  /** search: content grep skips files larger than this (NAS_MCP_GREP_MAX_FILE_BYTES, default 5 MB). */
  grepMaxFileBytes: number;
  /** Trash entries older than this many days are purged (NAS_MCP_TRASH_RETENTION_DAYS, default 30; 0 = keep forever). */
  trashRetentionDays: number;
  /** Seconds between Trash purges while running (NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS, default 3600). */
  trashPurgeIntervalSeconds: number;
}

export class ConfigError extends Error {}

/** Name of the Trash folder at the top of the Root (fixed; not configurable). */
export const TRASH_DIR_NAME = ".nas-mcp-trash";

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

/** Shortest accepted bearer token. */
export const MIN_TOKEN_LENGTH = 16;
/** Placeholder values from .env.example / docs that must never be used as the real token. */
const PLACEHOLDER_TOKENS = ["change-me", "<token>", "<placeholder>"];

function validateToken(token: string): string {
  if (PLACEHOLDER_TOKENS.includes(token.toLowerCase()) || /^<.*>$/.test(token)) {
    throw new ConfigError(
      `NAS_MCP_TOKEN is still the .env.example placeholder ("${token}"); generate a real one with: openssl rand -hex 32`,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `NAS_MCP_TOKEN is too short (${token.length} characters; at least ${MIN_TOKEN_LENGTH} required); generate one with: openssl rand -hex 32`,
    );
  }
  return token;
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
  const token = validateToken(required(env, "NAS_MCP_TOKEN"));
  const root = validateRoot(required(env, "NAS_MCP_ROOT"));
  return {
    root,
    token,
    port: int(env, "NAS_MCP_PORT", 8080, 0, 65535),
    host: env.NAS_MCP_HOST?.trim() || "0.0.0.0",
    trashDirName: TRASH_DIR_NAME,
    extraHiddenPatterns: list(env, "NAS_MCP_HIDDEN_PATTERNS"),
    readTextMaxBytes: int(env, "NAS_MCP_READ_TEXT_MAX_BYTES", 10 * 1024 * 1024, 1),
    readImageMaxBytes: int(env, "NAS_MCP_READ_IMAGE_MAX_BYTES", 20 * 1024 * 1024, 1),
    searchMaxResults: int(env, "NAS_MCP_SEARCH_MAX_RESULTS", 100, 1, 10_000),
    grepMaxFileBytes: int(env, "NAS_MCP_GREP_MAX_FILE_BYTES", 5 * 1024 * 1024, 1),
    trashRetentionDays: int(env, "NAS_MCP_TRASH_RETENTION_DAYS", 30, 0, 36_500),
    trashPurgeIntervalSeconds: int(env, "NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS", 3600, 1, 2_147_483),
  };
}
