// Keeps the documented settings in sync with the code: every env var the server
// (src/config.ts) or the Container Manager Project (compose.yaml) reads must be
// listed in .env.example and in the README's env var table, and nothing else.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");
const names = (text: string, re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1]!));
const sorted = (s: Set<string>) => [...s].sort();

const used = sorted(
  new Set([
    ...names(read("src/config.ts"), /"(NAS_MCP_[A-Z0-9_]+)"/g),
    ...names(read("src/config.ts"), /env\.(NAS_MCP_[A-Z0-9_]+)/g),
    ...names(read("compose.yaml"), /\b(NAS_MCP_[A-Z0-9_]+)\b/g),
  ]),
);

describe("env var documentation", () => {
  it("finds the env vars the code reads", () => {
    expect(used).toContain("NAS_MCP_TOKEN");
    expect(used).toContain("NAS_MCP_UID");
  });

  it(".env.example lists exactly the env vars the code and compose file read", () => {
    expect(sorted(names(read(".env.example"), /^(NAS_MCP_[A-Z0-9_]+)=/gm))).toEqual(used);
  });

  it("README env var table lists exactly the env vars the code and compose file read", () => {
    expect(sorted(names(read("README.md"), /^\| `(NAS_MCP_[A-Z0-9_]+)` \|/gm))).toEqual(used);
  });
});
