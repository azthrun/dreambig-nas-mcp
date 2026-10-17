import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";
import { trashFiles } from "./trash-helpers.js";

describe("edit", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "m/notes/plan.md": "# Plan\n- buy milk\n- call mom\n",
        "m/todo.txt": "a TODO\nb TODO\nc done\n",
        "m/windows.txt": "﻿one\r\ntwo\r\n",
        "m/blob.bin": Buffer.from([0x00, 0x01, 0x02, 0x61, 0xff]),
        "m/audit.md": "one",
        "m/.nas-mcp-trash/old.txt": "x",
        "m/big.txt": "x".repeat(65),
      },
      env: { NAS_MCP_READ_TEXT_MAX_BYTES: "64" },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  const content = (p: string) => readFile(path.join(s.root, "m", p), "utf8");

  it("replaces a unique string and keeps the pre-edit version in the Trash", async () => {
    const r = await s.call("edit", { path: "m/notes/plan.md", oldString: "buy milk", newString: "buy oat milk" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: "m/notes/plan.md", replacements: 1 });
    expect(await content("notes/plan.md")).toBe("# Plan\n- buy oat milk\n- call mom\n");
    const trashed = (await trashFiles(s.root)).filter((f) => f.path.endsWith("plan.md"));
    expect(trashed).toEqual([
      { path: expect.stringMatching(/^\d{4}-\d{2}-\d{2}\/notes\/plan\.md$/), content: "# Plan\n- buy milk\n- call mom\n" },
    ]);
  });

  it("fails when oldString is not found, leaving the file and Trash untouched", async () => {
    const before = await trashFiles(s.root);
    const r = await s.call("edit", { path: "m/todo.txt", oldString: "walk cat", newString: "walk dog" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^no_match/);
    expect(await content("todo.txt")).toBe("a TODO\nb TODO\nc done\n");
    expect(await trashFiles(s.root)).toEqual(before);
  });

  it("fails when oldString is not unique", async () => {
    const r = await s.call("edit", { path: "m/todo.txt", oldString: "TODO", newString: "DONE" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_unique: .*2 times/);
    expect(await content("todo.txt")).toBe("a TODO\nb TODO\nc done\n");
  });

  it("replaces every occurrence with replaceAll", async () => {
    const r = await s.call("edit", { path: "m/todo.txt", oldString: "TODO", newString: "DONE", replaceAll: true });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: "m/todo.txt", replacements: 2 });
    expect(await content("todo.txt")).toBe("a DONE\nb DONE\nc done\n");
    expect((await trashFiles(s.root)).map((f) => f.content)).toContain("a TODO\nb TODO\nc done\n");
  });

  it("keeps CRLF line endings and a byte-order mark intact", async () => {
    const r = await s.call("edit", { path: "m/windows.txt", oldString: "two", newString: "2" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await content("windows.txt")).toBe("﻿one\r\n2\r\n");
  });

  it("refuses files over the text read limit", async () => {
    const r = await s.call("edit", { path: "m/big.txt", oldString: "x", newString: "y" });
    expect(textOf(r)).toMatch(/^too_large/);
    expect(await content("big.txt")).toBe("x".repeat(65));
  });

  it("refuses non-text files", async () => {
    const r = await s.call("edit", { path: "m/blob.bin", oldString: "a", newString: "b" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_text/);
  });

  it("refuses folders and missing files", async () => {
    expect(textOf(await s.call("edit", { path: "m/notes", oldString: "a", newString: "b" }))).toMatch(/^not_a_file/);
    expect(textOf(await s.call("edit", { path: "m/nope.md", oldString: "a", newString: "b" }))).toMatch(/^not_found/);
  });

  it("refuses Hidden Entries such as the Trash", async () => {
    const r = await s.call("edit", { path: "m/.nas-mcp-trash/old.txt", oldString: "x", newString: "y" });
    expect(textOf(r)).toMatch(/^forbidden/);
  });

  it("emits an audit line naming the Path and where the pre-edit version went", async () => {
    await s.call("edit", { path: "m/audit.md", oldString: "one", newString: "two" });
    const line = await s.waitForAudit((l) => l.tool === "edit" && (l.paths as string[])[0] === "m/audit.md");
    expect(line).toMatchObject({ result: "ok", paths: ["m/audit.md"] });
    expect(line.trashed).toEqual([expect.stringMatching(/^m\/\.nas-mcp-trash\/\d{4}-\d{2}-\d{2}\/audit\.md$/)]);
  });
});
