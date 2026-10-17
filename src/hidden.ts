/**
 * Hidden Entry name and pattern matching, shared by the sandbox (every Path)
 * and config (Mount names). The Trash rule, which depends on where in a Mount
 * a name sits, lives in the sandbox.
 */
import path from "node:path";

/** Synology system entries, hidden at any depth. */
export const DEFAULT_HIDDEN_NAMES = ["@eaDir", "#recycle", "#snapshot", ".DS_Store"];

/**
 * Canonical form for Hidden Entry matching: Unicode NFC, lower case. Clients
 * (macOS especially) may send decomposed (NFD) names, and the NAS share is
 * typically case-insensitive over SMB, so `@EADIR` must not slip past `@eaDir`.
 */
export const fold = (s: string): string => s.normalize("NFC").toLowerCase();

/**
 * Matcher for built-in hidden names and NAS_MCP_HIDDEN_PATTERNS on a normalized
 * Root-relative Path: true if the Path or any of its parents is hidden. A pattern
 * without "/" matches a name at any depth; one with "/" matches a Path prefix.
 */
export function hiddenMatcher(extraPatterns: string[]): (rel: string) => boolean {
  const names = DEFAULT_HIDDEN_NAMES.map(fold);
  const patterns = extraPatterns.map(fold);
  return (rel) => {
    if (rel === "") return false;
    const segs = fold(rel).split("/");
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i];
      if (names.includes(name)) return true;
      const prefix = segs.slice(0, i + 1).join("/");
      for (const pattern of patterns) {
        if (pattern.includes("/") ? path.matchesGlob(prefix, pattern) : path.matchesGlob(name, pattern)) return true;
      }
    }
    return false;
  };
}
