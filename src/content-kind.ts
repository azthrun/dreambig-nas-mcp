/**
 * Content kind detection from a file's leading bytes (magic numbers + UTF-8 check).
 * Shared by `stat` and (later) the content reader used by `read`.
 */
import { open } from "node:fs/promises";

export type ContentKind = "text" | "pdf" | "image" | "binary";

export interface DetectedKind {
  kind: ContentKind;
  /** Set for pdf and image (and text/plain for text). */
  mimeType?: string;
}

const SNIFF_BYTES = 8192;

const startsWith = (buf: Buffer, sig: number[] | string, offset = 0) => {
  const bytes = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return buf.length >= offset + bytes.length && buf.subarray(offset, offset + bytes.length).equals(bytes);
};

function imageMime(buf: Buffer): string | undefined {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, "GIF87a") || startsWith(buf, "GIF89a")) return "image/gif";
  if (startsWith(buf, "RIFF") && startsWith(buf, "WEBP", 8)) return "image/webp";
  if (startsWith(buf, "ftyp", 4)) {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  return undefined;
}

function isUtf8Text(buf: Buffer, truncated: boolean): boolean {
  if (buf.includes(0)) return false;
  try {
    // stream: true tolerates a multi-byte character cut off at the sniff boundary.
    new TextDecoder("utf-8", { fatal: true }).decode(buf, { stream: truncated });
    return true;
  } catch {
    return false;
  }
}

export function detectKindFromBytes(buf: Buffer, truncated: boolean): DetectedKind {
  if (startsWith(buf, "%PDF-")) return { kind: "pdf", mimeType: "application/pdf" };
  const image = imageMime(buf);
  if (image) return { kind: "image", mimeType: image };
  if (isUtf8Text(buf, truncated)) return { kind: "text", mimeType: "text/plain" };
  return { kind: "binary" };
}

/** Detect the content kind of a file at a real absolute path. */
export async function detectKind(realPath: string): Promise<DetectedKind> {
  const fh = await open(realPath, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    const size = (await fh.stat()).size;
    return detectKindFromBytes(buf.subarray(0, bytesRead), size > bytesRead);
  } finally {
    await fh.close();
  }
}
