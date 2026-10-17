import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";

const exists = (p: string) => access(p).then(() => true, () => false);
const NFD_CAFE = "café"; // "café" decomposed (as macOS clients often send it)

/**
 * Hidden Entry matching is case-insensitive and Unicode-normalised, and is
 * applied to the final real Root-relative Path of entries that do not exist yet.
 */
describe("Hidden Entries", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: { "m/docs/readme.md": "hi", "m/docs/@EAdir/thumb.jpg": "x", "m/family/notes.md": "n", "m/src.txt": "s" },
      env: { NAS_MCP_HIDDEN_PATTERNS: "Private, m/family/taxes, café", NAS_MCP_TRASH_RETENTION_DAYS: "0" },
      setup: async (root) => {
        await symlink(root, path.join(root, "m/r"));
        await symlink(path.join(root, "m/family"), path.join(root, "m/fam"));
      },
    });
  });
  afterAll(() => s.stop());

  async function expectForbidden(tool: string, args: Record<string, unknown>) {
    const r = await s.call(tool, args);
    expect(r.isError, `${tool} ${JSON.stringify(args)}: ${textOf(r)}`).toBe(true);
    expect(textOf(r)).toMatch(/^forbidden/);
  }

  describe("names match case-insensitively and after NFC normalisation", () => {
    it("refuses built-in Hidden Entry names in another case", async () => {
      await expectForbidden("write", { path: "m/docs/@EADIR/x.txt", content: "x" });
      await expectForbidden("write", { path: "m/.NAS-MCP-TRASH/x.txt", content: "x" });
      await expectForbidden("write", { path: "m/docs/.ds_store", content: "x" });
      await expectForbidden("stat", { path: "m/docs/@EAdir" });
    });

    it("hides a built-in Hidden Entry in another case from list", async () => {
      const r = await s.call("list", { path: "m/docs" });
      expect((r.structuredContent as any).entries.map((e: any) => e.name)).toEqual(["readme.md"]);
    });

    it("refuses custom name and Path patterns in another case", async () => {
      await expectForbidden("write", { path: "m/PRIVATE/diary.md", content: "x" });
      await expectForbidden("write", { path: "m/Family/TAXES/2026.pdf", content: "x" });
    });

    it("refuses a name that matches a pattern only after NFC normalisation", async () => {
      await expectForbidden("write", { path: `m/${NFD_CAFE}/menu.md`, content: "x" });
      await expectForbidden("mkdir", { path: `m/${NFD_CAFE}` });
    });
  });

  describe("entries that do not exist yet are checked by their real Root-relative Path", () => {
    it("refuses writing into the Trash through a symlink to the Root, even before the Trash exists", async () => {
      expect(await exists(path.join(s.root, "m/.nas-mcp-trash"))).toBe(false);
      await expectForbidden("write", { path: "m/r/m/.nas-mcp-trash/x", content: "x" });
      await expectForbidden("mkdir", { path: "m/r/m/.nas-mcp-trash" });
      await expectForbidden("move", { from: "m/src.txt", to: "m/r/m/.nas-mcp-trash/x" });
      expect(await exists(path.join(s.root, "m/.nas-mcp-trash"))).toBe(false);
    });

    it("refuses writing to a hidden Path pattern through a symlinked folder", async () => {
      await expectForbidden("write", { path: "m/fam/taxes/2026.pdf", content: "x" });
      await expectForbidden("move", { from: "m/src.txt", to: "m/fam/taxes/x" });
      expect(await readdir(path.join(s.root, "m/family"))).toEqual(["notes.md"]);
    });

    it("still writes through a symlink to the Root to a visible Path", async () => {
      const r = await s.call("write", { path: "m/r/m/docs/new.md", content: "ok" });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(await exists(path.join(s.root, "m/docs/new.md"))).toBe(true);
    });
  });
});
