# dreambig-nas-mcp

An MCP server running in a container on a Synology NAS that lets agents read and manage files inside one designated folder.

## Language

**Root**:
The single NAS folder mounted into the container; the only part of the NAS the server can see or touch.
_Avoid_: Share, volume, mount, base dir

**Path**:
A location written relative to the Root, using `/` separators (e.g. `notes/2026/plan.md`); never an absolute NAS path.
_Avoid_: Full path, NAS path

**Trash**:
A server-owned folder inside the Root where deleted and overwritten files are moved instead of being destroyed. Never overwrites its own entries: a name clash gets a new name (`src/trash.ts`).
_Avoid_: Recycle bin, `#recycle` (that is Synology's own, separate bin)

**Hidden Entry**:
A file or folder inside the Root that agents can never list, read, or change, such as the Trash and Synology's system folders.
_Avoid_: Ignored file, excluded file

**Destructive Operation**:
Any change that removes or replaces existing content: delete, move, or overwrite.
_Avoid_: Dangerous operation, write
