# `delete` moves to Trash instead of destroying files

Agents get a `delete` tool in v1, but it never destroys data: deleted items, and files replaced by an overwrite or a colliding `move`, are moved into a server-owned Trash folder (one per Mount since ADR-0003) and purged after a configurable retention period (default 30 days, 0 = never). Synology's own `#recycle` bin only catches deletes made through SMB/File Station, so a real unlink from inside the container would be unrecoverable; agents make mistakes, and a rename costs almost nothing.

## Consequences

- Deleting a file frees no disk space until the Trash is purged.
- The Trash is a Hidden Entry: agents cannot list, read, or restore from it; recovery is done by a human via File Station.
