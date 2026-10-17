import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { detectKind } from "../content-kind.js";
import { defineTool } from "./types.js";

interface LineSlice {
  text: string;
  first: number;
  last: number;
  total: number;
}

/** Stream a UTF-8 file and keep lines [offset, offset + limit) (1-based), counting all lines. */
async function readLines(
  path: string,
  realPath: string,
  offset: number,
  limit: number,
  maxBytes: number,
): Promise<LineSlice> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const end = offset + limit; // exclusive
  let line = 1;
  let partial = "";
  const kept: string[] = [];
  let keptBytes = 0;
  const take = (l: string) => {
    if (line >= offset && line < end) {
      keptBytes += Buffer.byteLength(l);
      if (keptBytes > maxBytes) {
        throw new ToolError(
          "too_large",
          `${path}: lines ${offset}-${line} are over the ${maxBytes}-byte read limit; use a smaller limit`,
          [path],
        );
      }
      kept.push(l);
    }
    line++;
  };
  for await (const chunk of createReadStream(realPath)) {
    const parts = (partial + decoder.decode(chunk as Buffer, { stream: true })).split("\n");
    partial = parts.pop()!;
    for (const p of parts) take(p + "\n");
  }
  partial += decoder.decode();
  if (partial) take(partial);
  const total = line - 1;
  return { text: kept.join(""), first: offset, last: offset + kept.length - 1, total };
}

/** Thrown by the UTF-8 decoders when a file that sniffed as text is not valid UTF-8 after all. */
const isDecodeError = (e: unknown) => e instanceof TypeError && (e as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA";

function decodeUtf8(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

function binaryMetadata(path: string, st: Stats): CallToolResult {
  const meta = {
    path,
    size: st.size,
    modified: st.mtime.toISOString(),
    contentKind: "binary",
    note: "Binary file: contents are not returned (only UTF-8 text, PDF, and images can be read).",
  };
  return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }] };
}

function tooLarge(path: string, size: number, max: number, what: string, hint = ""): ToolError {
  return new ToolError("too_large", `${path} is ${size} bytes, over the ${max}-byte ${what} read limit${hint}`, [path]);
}

async function pdfText(path: string, realPath: string): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(realPath)));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.join("\n\n");
  } catch (e) {
    throw new ToolError("not_text", `${path}: could not extract text from PDF (${(e as Error).message})`, [path]);
  }
}

export const readTool = defineTool({
  name: "read",
  title: "Read file",
  description:
    "Read a file inside the Root. UTF-8 text returns its contents (use offset/limit, in lines, for large files; " +
    "partial reads end with a note like \"[lines 1-200 of 5000; more available, continue with offset 201]\"). " +
    "PDF returns its extracted text. Images (PNG, JPEG, GIF, WebP, HEIC, AVIF, TIFF) return image content. " +
    "Any other binary file returns metadata only. Files over the size limit return a too_large error.",
  inputSchema: {
    path: z.string().describe('Root-relative Path, e.g. "docs/notes/plan.md"'),
    offset: z.number().int().min(1).optional().describe("Text files: first line to return (1-based)"),
    limit: z.number().int().min(1).optional().describe("Text files: maximum number of lines to return"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ path, offset, limit }, { sandbox, config }) {
    const entry = await sandbox.resolve(path);
    const st = await stat(entry.real);
    if (!st.isFile()) {
      throw new ToolError("not_a_file", `${entry.path || "/"} is not a file; use list for folders`, [entry.path]);
    }
    const kind = await detectKind(entry.real);
    if (kind.kind === "binary") return binaryMetadata(entry.path, st);
    if (kind.kind === "image") {
      if (st.size > config.readImageMaxBytes) throw tooLarge(entry.path, st.size, config.readImageMaxBytes, "image");
      const data = (await readFile(entry.real)).toString("base64");
      return { content: [{ type: "image", data, mimeType: kind.mimeType! }] };
    }
    if (kind.kind === "pdf") {
      if (st.size > config.readTextMaxBytes) throw tooLarge(entry.path, st.size, config.readTextMaxBytes, "text/PDF");
      const text = await pdfText(entry.path, entry.real);
      if (!text.trim()) {
        return { content: [{ type: "text", text: `${entry.path}: PDF has no extractable text (it may be scanned images).` }] };
      }
      return { content: [{ type: "text", text }] };
    }
    if (offset === undefined && limit === undefined) {
      if (st.size > config.readTextMaxBytes) {
        throw tooLarge(
          entry.path,
          st.size,
          config.readTextMaxBytes,
          "text/PDF",
          "; read it in parts with offset and limit (lines)",
        );
      }
      let text: string;
      try {
        text = decodeUtf8(await readFile(entry.real));
      } catch (e) {
        if (isDecodeError(e)) return binaryMetadata(entry.path, st);
        throw e;
      }
      return { content: [{ type: "text", text }] };
    }
    let s: LineSlice;
    try {
      s = await readLines(
        entry.path,
        entry.real,
        offset ?? 1,
        limit ?? Number.MAX_SAFE_INTEGER,
        config.readTextMaxBytes,
      );
    } catch (e) {
      if (isDecodeError(e)) return binaryMetadata(entry.path, st);
      throw e;
    }
    const note =
      s.last < s.first
        ? `[no lines at offset ${s.first}; the file has ${s.total} lines]`
        : `[lines ${s.first}-${s.last} of ${s.total}` +
          (s.last < s.total ? `; more available, continue with offset ${s.last + 1}]` : "]");
    return {
      content: [
        { type: "text", text: s.text },
        { type: "text", text: note },
      ],
    };
  },
});
