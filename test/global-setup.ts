/**
 * Builds `dist/` once before the suite; the harness runs the compiled server
 * (`node dist/index.js`), i.e. the same artifact that ships.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function setup() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
  execFileSync(tsc, ["-p", "tsconfig.build.json"], { cwd: repoRoot, stdio: "inherit" });
}
