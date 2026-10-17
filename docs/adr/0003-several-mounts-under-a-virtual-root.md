# Several Mounts under a virtual Root

One server exposes several NAS shared folders under one token and URL. Each is bind-mounted into the container as a folder under `/data` (a **Mount**), and the Root becomes a virtual top level whose entries are exactly the Mounts, so a Path starts with the Mount name (`documents/tax/2025.pdf`). No tool schema changed: `list("")` lists the Mounts, and `search` covers all of them.

- **Auto-discovery.** Mounts are the folders under `/data`, declared only by `compose.yaml` volume lines (compose cannot loop over a list from `.env`, so a separate list would have to be kept in sync by hand). Startup fails fast if an entry there is not a folder, is not its own mount point (catches nested container paths and the old single-folder layout), has a reserved or hidden name, clashes in case with another, or if there are none.
- **Read-only Mounts** are mounted `:ro` (kernel-enforced) or not writable by the server's user (detected with `access(W_OK)` at startup, logged as a warning). The sandbox refuses every change inside them, judged by the real location, so a symlink cannot route a write into one.
- **The top level is read-only.** Agents cannot create, rename, replace or delete a Mount, or put anything beside the Mounts.
- **Trash per Mount** at `<mount>/.nas-mcp-trash`. Each Mount may be a different filesystem; a single Trash would turn every delete into a copy (slow, not atomic). Read-only Mounts have no Trash; purge and temp-file cleanup skip them. Audit lines name Trash entries by their full Path.
- **No move between Mounts.** A cross-filesystem `move` would be a non-atomic copy that can leave both halves behind on failure; agents read, write and delete instead. Symlinks between Mounts are allowed; every operation applies to the real target's Mount.

## Considered Options

- **A `root` argument on every tool**: rejected; a schema change on all nine tools (two on `move`) for no gain over the first Path segment.
- **`NAS_MCP_MOUNTS` env list alongside the compose volumes**: rejected; two places to keep in sync.
- **A single-Root legacy mode**: rejected; one deployment, and two code paths forever. Released as a breaking v2.0.0 with a README migration section.

## Consequences

- Hidden patterns with `/` now include the Mount (`documents/family/taxes`).
- Nested mounts (a bind mount inside a Mount) are not supported.
- Running outside the container with plain folders as Mounts needs `NAS_MCP_REQUIRE_MOUNT_POINTS=false`.
