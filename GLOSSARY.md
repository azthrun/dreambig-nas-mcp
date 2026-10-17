# dreambig-nas-mcp

An MCP server running in a container on a Synology NAS that lets agents read and manage files inside designated NAS shared folders.

## Language

**Root**:
The virtual top level grouping all Mounts (`/data` in the container); the only part of the NAS the server can see or touch. It is read-only: its entries are exactly the Mounts.
_Avoid_: Share, volume, base dir

**Mount**:
One NAS shared folder (or sub-folder) bind-mounted into the container as a folder at the top of the Root; its name is the first segment of every Path inside it. Discovered at startup; never created, renamed or deleted by agents. A read-only Mount (mounted `:ro`, or not writable by the server's user) refuses every change.
_Avoid_: Share, volume, root

**Path**:
A location written relative to the Root, using `/` separators and starting with a Mount (e.g. `documents/notes/2026/plan.md`); never an absolute NAS path.
_Avoid_: Full path, NAS path

**Trash**:
A server-owned folder at the top of each writable Mount where deleted and overwritten files are moved instead of being destroyed. Never overwrites its own entries: a name clash gets a new name (`src/trash.ts`).
_Avoid_: Recycle bin, `#recycle` (that is Synology's own, separate bin)

**Hidden Entry**:
A file or folder inside a Mount that agents can never list, read, or change, such as the Trash and Synology's system folders.
_Avoid_: Ignored file, excluded file

**Destructive Operation**:
Any change that removes or replaces existing content: delete, move, or overwrite.
_Avoid_: Dangerous operation, write
