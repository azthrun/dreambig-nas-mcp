/** Test helpers for inspecting the Trash folder on disk. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TRASH_DIR_NAME } from "../src/config.js";

/** Name of the Trash folder at the top of the Root. */
export const TRASH_DIR = TRASH_DIR_NAME;

/** Every file in the Trash, as Trash-relative Paths (sorted) with their text content. */
export async function trashFiles(root: string): Promise<{ path: string; content: string }[]> {
  const trash = path.join(root, TRASH_DIR);
  let entries;
  try {
    entries = await readdir(trash, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out.push({ path: path.relative(trash, abs).split(path.sep).join("/"), content: await readFile(abs, "utf8") });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Every entry (files and folders) under `dir`, recursively, as relative Paths. */
export async function allEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((e) => e.split(path.sep).join("/")).sort();
}
