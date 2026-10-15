import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTempDir, runServerExpectingExit, startServer, textOf, TEST_TOKEN, type TestServer } from "./harness.js";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const TEXT = "# Plan\nnaïve café ✓\nline 3\nline 4\nline 5\n";
// Minimal 1x1 PNG.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00, 0x10]);
// Looks like text for the first 8 KB, then has an invalid UTF-8 byte.
const LATE_BINARY = Buffer.concat([Buffer.from("a".repeat(10_000)), Buffer.from([0xff, 0x0a])]);
/** A minimal valid one-page PDF showing `text` (Helvetica), with a correct xref table. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PDF = makePdf("Hello from the NAS");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

describe("read", () => {
  let s: TestServer;
  let outside = "";
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "notes/plan.md": TEXT,
        "photos/dot.png": PNG,
        "photos/pic.jpg": JPEG,
        "blob.bin": BINARY,
        "docs/hello.pdf": PDF,
        "late.dat": LATE_BINARY,
        "docs/@eaDir/thumb.txt": "x",
        ".nas-mcp-trash/2026-01-01/gone.txt": "old",
        "private/diary.md": "secret",
        "folder/": "",
      },
      env: { NAS_MCP_HIDDEN_PATTERNS: "private" },
      setup: async (root) => {
        outside = await makeTempDir("nas-mcp-outside-");
        await writeFile(path.join(outside, "secret.txt"), "outside");
        await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
      },
    });
  });
  afterAll(async () => {
    await s.stop();
    await rm(outside, { recursive: true, force: true });
  });

  it("is advertised as read-only", async () => {
    const { tools } = await s.client.listTools();
    const read = tools.find((t) => t.name === "read");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBeFalsy();
  });

  it("returns the contents of a UTF-8 text file", async () => {
    const r = await s.call("read", { path: "notes/plan.md" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toBe(TEXT);
  });

  it("returns the requested lines with offset (1-based) and limit, and says which lines they are", async () => {
    const r = await s.call("read", { path: "notes/plan.md", offset: 2, limit: 2 });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toBe("naïve café ✓\nline 3\n");
    expect(r.content[1]).toEqual({ type: "text", text: "[lines 2-3 of 5; more available, continue with offset 4]" });
  });

  it("reads to the end when only offset is given", async () => {
    const r = await s.call("read", { path: "notes/plan.md", offset: 4 });
    expect(textOf(r)).toBe("line 4\nline 5\n");
    expect(r.content[1]).toEqual({ type: "text", text: "[lines 4-5 of 5]" });
  });

  it("returns nothing past the end of the file", async () => {
    const r = await s.call("read", { path: "notes/plan.md", offset: 9 });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toBe("");
    expect(r.content[1]).toEqual({ type: "text", text: "[no lines at offset 9; the file has 5 lines]" });
  });

  it("returns an image as MCP image content with its MIME type", async () => {
    const r = await s.call("read", { path: "photos/dot.png" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.content).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
    const j = await s.call("read", { path: "photos/pic.jpg" });
    expect(j.content).toEqual([{ type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" }]);
  });

  it("returns only metadata for a binary file", async () => {
    const r = await s.call("read", { path: "blob.bin" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(textOf(r))).toMatchObject({
      path: "blob.bin",
      size: BINARY.length,
      contentKind: "binary",
    });
  });

  it("treats a file that turns out not to be UTF-8 past the first bytes as binary", async () => {
    const r = await s.call("read", { path: "late.dat" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r))).toMatchObject({ path: "late.dat", size: LATE_BINARY.length, contentKind: "binary" });
    const part = await s.call("read", { path: "late.dat", offset: 1, limit: 1 });
    expect(JSON.parse(textOf(part))).toMatchObject({ contentKind: "binary" });
  });

  for (const p of [
    "../etc/passwd",
    "/etc/passwd",
    "leak.txt",
    ".nas-mcp-trash/2026-01-01/gone.txt",
    "docs/@eaDir/thumb.txt",
    "private/diary.md",
  ]) {
    it(`refuses ${p} (Path escape or Hidden Entry) and audits it`, async () => {
      const r = await s.call("read", { path: p });
      expect(r.isError, textOf(r)).toBe(true);
      expect(textOf(r)).toMatch(/^forbidden/);
      const line = await s.waitForAudit((l) => l.tool === "read" && (l.paths as string[] | undefined)?.includes(p) === true);
      expect(line).toMatchObject({ result: "rejected", reason: "forbidden" });
    });
  }

  it("returns not_a_file for a folder", async () => {
    const r = await s.call("read", { path: "folder" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_a_file/);
  });

  it("returns not_found for a missing file", async () => {
    const r = await s.call("read", { path: "notes/nope.md" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_found/);
  });

  it("returns the extracted text of a PDF", async () => {
    const r = await s.call("read", { path: "docs/hello.pdf" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r).trim()).toBe("Hello from the NAS");
  });
});

describe("read size limits", () => {
  // 10 lines of 9 bytes = 90 bytes, over the 64-byte text limit below.
  const BIG_TEXT = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}\n`).join("");
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({
      layout: {
        "big.txt": BIG_TEXT,
        "small.txt": "fits\n",
        "big.pdf": makePdf("x".repeat(80)),
        "dot.png": PNG, // 66 bytes
        "pic.jpg": JPEG, // 11 bytes
      },
      env: { NAS_MCP_READ_TEXT_MAX_BYTES: "64", NAS_MCP_READ_IMAGE_MAX_BYTES: "50" },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  it("refuses a whole text file over the limit with a clear error pointing at offset/limit", async () => {
    const r = await s.call("read", { path: "big.txt" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^too_large: .*big\.txt.*90 bytes.*64.*offset/);
  });

  it("still reads an over-limit text file in parts", async () => {
    const r = await s.call("read", { path: "big.txt", offset: 9, limit: 5 });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toBe("line 009\nline 010\n");
  });

  it("refuses a part that is itself over the limit", async () => {
    const r = await s.call("read", { path: "big.txt", offset: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^too_large:/);
  });

  it("reads files under the limit", async () => {
    expect(textOf(await s.call("read", { path: "small.txt" }))).toBe("fits\n");
    expect((await s.call("read", { path: "pic.jpg" })).content[0]).toMatchObject({ type: "image" });
  });

  it("refuses a PDF over the text/PDF limit", async () => {
    const r = await s.call("read", { path: "big.pdf" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^too_large: .*big\.pdf/);
  });

  it("refuses an image over the image limit", async () => {
    const r = await s.call("read", { path: "dot.png" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^too_large: .*dot\.png.*66 bytes.*50/);
  });

  it("refuses to start with an invalid limit", async () => {
    const root = await makeTempDir();
    try {
      const { code, stderr } = await runServerExpectingExit({
        NAS_MCP_TOKEN: TEST_TOKEN,
        NAS_MCP_ROOT: root,
        NAS_MCP_READ_IMAGE_MAX_BYTES: "lots",
      });
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/NAS_MCP_READ_IMAGE_MAX_BYTES/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
