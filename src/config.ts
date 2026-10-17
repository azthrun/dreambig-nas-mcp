/**
 * Config: reads and validates env vars once at startup; fails fast.
 *
 * To add a setting: add a field to `Config`, parse it in `loadConfig` with the
 * helpers below, and list it in `.env.example`.
 */
import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HIDDEN_NAMES, fold, hiddenMatcher } from "./hidden.js";

/** A folder at the top of the Root: one NAS shared folder bind-mounted into the container (ADR-0003). */
export interface Mount {
  /** Folder name at the top of the Root; the first segment of every Path inside it. */
  name: string;
  /** Real absolute path. */
  abs: string;
  /** Every change inside it is refused: mounted `:ro`, or the server's user cannot write to it. */
  readOnly: boolean;
  /** Why it is read-only when the mount itself is not `:ro` (logged as a startup warning). */
  readOnlyWarning?: string;
}

export interface Config {
  /** Real absolute path of the Root: the folder whose sub-folders are the Mounts. */
  root: string;
  /** The Mounts, sorted by name. */
  mounts: Mount[];
  /** Bearer token required on every /mcp request. */
  token: string;
  /** Listen port (container port; default 8080; 0 = pick a free port). */
  port: number;
  /** Listen address. */
  host: string;
  /** Name of the Trash folder at the top of each Mount (a Hidden Entry). */
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

/** Name of the Trash folder at the top of each Mount (fixed; not configurable). */
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

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(`${name} must be true or false (got "${env[name]}")`);
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

/**
 * Discover the Mounts: every entry at the top of the Root must be a folder that
 * is its own mount point (unless `requireMountPoints` is off, for local runs and
 * tests) with a usable name. Fails fast on anything else, so a typo in a compose
 * volume line or the old single-folder layout is caught at startup.
 */
function discoverMounts(root: string, extraHiddenPatterns: string[], requireMountPoints: boolean): Mount[] {
  const rootDev = statSync(root).dev;
  const isHidden = hiddenMatcher(extraHiddenPatterns);
  const reserved = [...DEFAULT_HIDDEN_NAMES, TRASH_DIR_NAME].map(fold);
  const seen = new Map<string, string>();
  const mounts: Mount[] = [];
  for (const name of readdirSync(root).sort()) {
    const abs = path.join(root, name);
    const st = lstatSync(abs);
    if (!st.isDirectory()) {
      throw new ConfigError(
        `${abs} is not a folder; everything at the top of NAS_MCP_ROOT must be a mounted folder (a Mount), ` +
          "e.g. /volume1/docs:/data/docs in compose.yaml (see the README migration section)",
      );
    }
    if (name.startsWith(".") || reserved.includes(fold(name)) || isHidden(name)) {
      throw new ConfigError(`Mount name "${name}" is reserved or hidden; mount it under another name`);
    }
    const clash = seen.get(fold(name));
    if (clash) throw new ConfigError(`Mount names "${clash}" and "${name}" differ only in case; rename one`);
    seen.set(fold(name), name);
    if (requireMountPoints && st.dev === rootDev) {
      throw new ConfigError(
        `${abs} is not a mount point; mount a shared folder there in compose.yaml (e.g. /volume1/${name}:${abs}), ` +
          "or remove it. Mounting one folder at NAS_MCP_ROOT itself is the old single-folder layout: see the README migration section",
      );
    }
    let readOnly = false;
    let readOnlyWarning: string | undefined;
    try {
      accessSync(abs, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (err) {
      try {
        accessSync(abs, constants.R_OK | constants.X_OK);
      } catch {
        throw new ConfigError(`Mount ${name} is not readable: ${abs}`);
      }
      readOnly = true;
      if ((err as NodeJS.ErrnoException).code !== "EROFS") {
        readOnlyWarning = "the server's user cannot write to it, so it is read-only; mount it :ro, or grant Read/Write in DSM";
      }
    }
    mounts.push({ name, abs: realpathSync(abs), readOnly, ...(readOnlyWarning ? { readOnlyWarning } : {}) });
  }
  if (mounts.length === 0) {
    throw new ConfigError(`NAS_MCP_ROOT has no Mounts: ${root}; mount at least one shared folder under it in compose.yaml`);
  }
  return mounts;
}

export function loadConfig(env: Env = process.env): Config {
  const token = validateToken(required(env, "NAS_MCP_TOKEN"));
  const root = validateRoot(required(env, "NAS_MCP_ROOT"));
  const extraHiddenPatterns = list(env, "NAS_MCP_HIDDEN_PATTERNS");
  const requireMountPoints = bool(env, "NAS_MCP_REQUIRE_MOUNT_POINTS", true);
  const settings = {
    root,
    token,
    port: int(env, "NAS_MCP_PORT", 8080, 0, 65535),
    host: env.NAS_MCP_HOST?.trim() || "0.0.0.0",
    trashDirName: TRASH_DIR_NAME,
    extraHiddenPatterns,
    readTextMaxBytes: int(env, "NAS_MCP_READ_TEXT_MAX_BYTES", 10 * 1024 * 1024, 1),
    readImageMaxBytes: int(env, "NAS_MCP_READ_IMAGE_MAX_BYTES", 20 * 1024 * 1024, 1),
    searchMaxResults: int(env, "NAS_MCP_SEARCH_MAX_RESULTS", 100, 1, 10_000),
    grepMaxFileBytes: int(env, "NAS_MCP_GREP_MAX_FILE_BYTES", 5 * 1024 * 1024, 1),
    trashRetentionDays: int(env, "NAS_MCP_TRASH_RETENTION_DAYS", 30, 0, 36_500),
    trashPurgeIntervalSeconds: int(env, "NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS", 3600, 1, 2_147_483),
  };
  // Last, so a bad setting is reported even before any Mount is set up.
  return { ...settings, mounts: discoverMounts(root, extraHiddenPatterns, requireMountPoints) };
}
