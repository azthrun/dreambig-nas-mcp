# Coding standards

Read during review. Terms (Root, Path, Trash, Hidden Entry, Destructive Operation) are defined in `GLOSSARY.md`; decisions in `docs/adr/`. Typecheck, tests and the gitleaks scan run in CI; this file covers only what they cannot judge.

## Filesystem safety

- **Every agent-supplied Path goes through `Sandbox`** (`src/sandbox.ts`). A tool that calls `node:fs` on a string it built from input, without a `Resolved`/`Located` from the sandbox, is a hard violation.
- **Destructive Operations never destroy data.** Anything removed or replaced goes to the Trash via `Trash` (`src/trash.ts`), which never overwrites an existing Trash entry: on a name clash it picks a new name. Code that unlinks, `rm`s, or renames over existing content outside `trash.ts` / `trash-purge.ts` / temp cleanup breaks ADR-0001.
- **Every change to the Root runs under the write lock** (`src/write-lock.ts`). The registry (`src/mcp.ts`) locks any tool whose `readOnlyHint` is not true, so a mutating tool marked read-only escapes the lock; background jobs that touch the Root call `withWriteLock` themselves. Re-check the resolved parent (`Sandbox.recheck`) right before renaming.
- **Text writes are atomic** via `src/atomic-write.ts` (temp file in the same folder, fsync, rename).
- **Symlinks:** a move/delete source or move target is located as itself (`resolveEntry` / `locateForCreate`); reads follow links but must stay inside the Root.

## Tool shape

- New tools use `defineTool` (`src/tools/types.ts`) with zod input/output schemas and accurate MCP `annotations` (`destructiveHint` true for anything that removes or replaces content).
- Failures throw `ToolError` with an existing `ToolErrorCode` (`src/errors.ts`); add a code only when no existing one fits.
- Every write, Destructive Operation, and rejection emits one audit line (`src/audit.ts`), naming the Paths and where replaced content went in the Trash.

## Config

- Settings come from `NAS_MCP_*` env vars parsed in `src/config.ts`, never read from `process.env` elsewhere. A new variable is added to `.env.example` and the README table (`test/env-docs.test.ts` checks this).
- Docs and examples use placeholders (`192.168.1.10`, `nas.<tailnet>.ts.net`, `<token>`), never the owner's real values.

## Tests

- Behaviour is tested end to end through the MCP server (`test/harness.ts` `startServer` with a temp Root `layout`), not by unit-testing private helpers.
- A safety rule above gets a test that tries to break it: Path escape, symlink out of Root, Hidden Entry access, Trash name clash.
