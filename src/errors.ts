/**
 * Tool errors: throw a ToolError from any tool or shared module; the registry
 * turns it into an MCP tool error result (`isError: true`) whose text starts
 * with the code, e.g. "not_found: notes/x.md does not exist".
 *
 * `forbidden` errors are rejections: the registry also writes an audit line.
 */
export type ToolErrorCode =
  | "invalid" // malformed argument (bad cursor, etc.)
  | "not_found"
  | "exists"
  | "too_large"
  | "forbidden" // Path escape, Hidden Entry, symlink out of Root, permission denied
  | "not_text"
  | "not_a_folder"
  | "not_a_file"
  | "no_match" // edit: oldString not found
  | "not_unique"; // edit: oldString occurs more than once

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    /** Root-relative Path(s) involved, for the audit log. */
    readonly paths: string[] = [],
  ) {
    super(message);
  }
}
