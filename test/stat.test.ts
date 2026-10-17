import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { utimes } from "node:fs/promises";
import path from "node:path";
import { startServer, textOf, type TestServer } from "./harness.js";

// Minimal 1x1 PNG.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00, 0x10]);

describe("stat", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "m/notes/plan.md": "# Plan\nnaïve café ✓\n",
        "m/empty.txt": "",
        "m/photo.png": PNG,
        "m/pic.jpg": JPEG,
        "m/doc.pdf": PDF,
        "m/blob.bin": BINARY,
        "m/folder/": "",
      },
      setup: async (root) => {
        const t = new Date("2023-05-06T07:08:09Z");
        await utimes(path.join(root, "m/notes/plan.md"), t, t);
      },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  const st = async (p: string) => {
    const r = await s.call("stat", { path: p });
    expect(r.isError, textOf(r)).toBeFalsy();
    return r.structuredContent as Record<string, any>;
  };

  it("returns type, size, timestamps and content kind for a text file", async () => {
    const info = await st("m/notes/plan.md");
    expect(info).toMatchObject({
      path: "m/notes/plan.md",
      type: "file",
      size: Buffer.byteLength("# Plan\nnaïve café ✓\n"),
      modified: "2023-05-06T07:08:09.000Z",
      contentKind: "text",
    });
    expect(Number.isNaN(Date.parse(info.created))).toBe(false);
  });

  it("detects content kinds", async () => {
    expect((await st("m/empty.txt")).contentKind).toBe("text");
    expect(await st("m/photo.png")).toMatchObject({ contentKind: "image", mimeType: "image/png" });
    expect(await st("m/pic.jpg")).toMatchObject({ contentKind: "image", mimeType: "image/jpeg" });
    expect(await st("m/doc.pdf")).toMatchObject({ contentKind: "pdf", mimeType: "application/pdf" });
    expect((await st("m/blob.bin")).contentKind).toBe("binary");
  });

  it("stats a folder (no content kind)", async () => {
    const info = await st("m/folder");
    expect(info.type).toBe("folder");
    expect(info.contentKind).toBeUndefined();
  });

  it("returns not_found for a missing Path", async () => {
    const r = await s.call("stat", { path: "m/nope.txt" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_found/);
  });

  it("is also returned as JSON text", async () => {
    const r = await s.call("stat", { path: "m/photo.png" });
    expect(JSON.parse(textOf(r))).toEqual(r.structuredContent);
  });
});
