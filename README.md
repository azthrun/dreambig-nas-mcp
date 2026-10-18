# dreambig-nas-mcp

An MCP server that runs in a container on a Synology NAS and lets agents (Claude Code, Claude Desktop) read and manage files inside one or more NAS shared folders. Each is a **Mount**: a top-level folder of the **Root** that every Path starts with (e.g. `documents/notes/plan.md`). A Mount can be read-only. Nothing else on the NAS is visible.

- Tools: `list`, `stat`, `read` (text, PDF text, images), `search` (name glob + optional content grep), `write`, `edit`, `mkdir`, `move`, `delete`.
- Transport: Streamable HTTP at `http://<nas>:<port>/mcp`, LAN only (remote access via Tailscale), one static bearer token ([ADR-0002](docs/adr/0002-lan-only-static-bearer-token.md)).
- Nothing is ever really deleted by an agent: deleted and overwritten content goes to a Trash folder inside its Mount ([ADR-0001](docs/adr/0001-delete-moves-to-trash.md)). Mounts: [ADR-0003](docs/adr/0003-several-mounts-under-a-virtual-root.md).
- Vocabulary (Root, Mount, Path, Trash, Hidden Entry, Destructive Operation): [GLOSSARY.md](GLOSSARY.md).
- Upgrading from v1 (one folder as the Root): see [Migrating from v1](#migrating-from-v1-single-root).

Target: DS220+ (Intel, `linux/amd64`), DSM 7.4.1, Container Manager.

## Synology setup

You need: DSM admin access, a Mac on the same LAN, and the NAS's LAN IP address (Control Panel > Network > Network Interface). This README uses `192.168.1.10` as a placeholder; substitute your NAS's actual IP everywhere. Don't use the router/default gateway IP (often `x.x.x.1`); it isn't the NAS. Below, `agents` (read/write) and `photos` (read-only) are the example shared folders used as Mounts and `nas-mcp` the example DSM user; use your own names.

### 1. Choose or create the shared folders (Mounts)

For each folder agents should see:

1. DSM > **Control Panel > Shared Folder**.
2. Either pick an existing shared folder, or click **Create > Create Shared Folder**, name it (e.g. `agents`), pick the volume (e.g. Volume 1), and finish the wizard (you can leave encryption and advanced options off).
3. Note its NAS path: `/volume1/agents` (volume number + folder name). You can also use a sub-folder, e.g. `/volume1/agents/claude`; the agent sees only what is mounted.
4. Decide its Mount name (the top-level folder agents see, e.g. `agents`; letters, digits, `-`/`_`; not starting with `.`) and whether agents may change it (read/write) or only read it (read-only).

### 2. Create a dedicated DSM user

1. **Control Panel > User & Group > User > Create**.
2. Name: `nas-mcp`. Set a long random password (nobody needs to log in as this user). Tick **Disallow the user to change account password**. Next.
3. **Join groups**: leave only `users`. Next.
4. **Assign shared folders permissions**: tick **Read/Write** for each read/write Mount (e.g. `agents`) and **Read only** for each read-only Mount (e.g. `photos`); tick **No access** for every other shared folder. Next.
5. **Assign user quota**: skip. Next.
6. **Assign application permissions**: tick **Deny** for every application (the container does not need DSM apps). Next.
7. **Set user speed limit**: skip. Next, **Done**.
8. Check: **Control Panel > Shared Folder >** select `agents` **> Edit > Permissions** shows `nas-mcp` with Read/Write (and `photos` with Read only). If you picked an existing folder, also make sure no group gives `nas-mcp` access to other folders (the `users` group's permissions apply to it too: check **User & Group > Group > users > Edit > Permissions**).

### 3. Find the user's UID and GID

**Option A: SSH (one-off).**

1. **Control Panel > Terminal & SNMP > Terminal**: tick **Enable SSH service** (port 22), **Apply**.
2. On the Mac, in Terminal: `ssh <your-admin-user>@192.168.1.10`, enter the admin password.
3. Run `id nas-mcp`. Output looks like `uid=1030(nas-mcp) gid=100(users) groups=100(users)`. Write down the `uid` number (here `1030`) and the `gid` number (here `100`).
4. `exit`, then untick **Enable SSH service** again and **Apply** (unless you use SSH anyway).

**Option B: no SSH (Task Scheduler).**

1. **Control Panel > Task Scheduler > Create > Scheduled Task > User-defined script**.
2. **General** tab: Task name `nas-mcp-id`, User `root`, untick **Enabled** (you run it by hand).
3. **Task Settings** tab, **Run command**: `id nas-mcp > /volume1/agents/nas-mcp-id.txt` (any shared folder you can open in File Station works). OK, confirm the warning.
4. Select the task, click **Run**. Open **File Station**, open `nas-mcp-id.txt`, note `uid` and `gid` as in option A.
5. Delete `nas-mcp-id.txt` and the `nas-mcp-id` task.

The container never runs as root: `NAS_MCP_UID` and `NAS_MCP_GID` must be these numbers, not `0`.

### 4. Generate the bearer token

On the Mac: `openssl rand -hex 32`. Copy the 64-character output; it is `NAS_MCP_TOKEN` below and goes into each client config. Treat it like a password (anyone on the LAN who has it can read and change files in the Mounts). To rotate it later, change it in `.env`, rebuild the Project (step 7), and update the clients.

### 5. Image access (GHCR)

The image is `ghcr.io/azthrun/dreambig-nas-mcp:latest` (`linux/amd64`), built and pushed by CI when a GitHub release with a `v*` tag (e.g. `v1.2.0`) is published; each release is also tagged `:<version>` (e.g. `:v1.2.0`). Prereleases get only the version tag, not `:latest`. It contains no secrets.

- **Public package (recommended, no login on the NAS).** Once, on github.com: your profile > **Packages > dreambig-nas-mcp > Package settings > Danger Zone > Change visibility > Public**. Check: on the Mac, `docker pull ghcr.io/azthrun/dreambig-nas-mcp:latest` works without `docker login` (or open `https://github.com/users/azthrun/packages/container/package/dreambig-nas-mcp` in a private browser window).
- **Private package.** Create a GitHub **classic** personal access token with only the `read:packages` scope (github.com > Settings > Developer settings > Personal access tokens > Tokens (classic) > Generate new token). Then over SSH on the NAS (step 3, option A): `sudo docker login ghcr.io -u <github-user>` and paste the token as the password. Container Manager's engine then uses those credentials for `ghcr.io` pulls.

### 6. Prepare the Project folder and `.env`

1. **File Station**: create a folder for the Project, e.g. `docker/dreambig-nas-mcp` (create the `docker` shared folder first if you don't have one). Do not put it inside a Mount, and don't mount the `docker` folder. A `volumes:` line whose NAS path doesn't exist makes Docker create an empty folder there, so the Mount shows up empty: check the paths.
2. On the Mac, copy [`.env.example`](.env.example) from this repo to a file named `env.txt` and fill in:
   - `NAS_MCP_TOKEN` = the token from step 4
   - `NAS_MCP_UID`, `NAS_MCP_GID` = the numbers from step 3
   - `NAS_MCP_HOST_PORT` = a free port on the NAS (default `8080`; DSM itself uses 5000/5001)
   - Leave `NAS_MCP_ROOT`, `NAS_MCP_PORT`, `NAS_MCP_HOST` as they are (compose fixes them). Other settings: see [Settings](#settings).
3. In File Station, upload `env.txt` into `docker/dreambig-nas-mcp`, then right-click it > **Rename** to `.env`. (File Station hides dot-files unless **Settings > General > Show hidden files** is ticked; the file is still there.)
4. Keep `.env` out of git and out of any folder agents can see.

### 7. Create the Container Manager Project

1. Install **Container Manager** from Package Center if it isn't installed.
2. **Container Manager > Project > Create**.
3. **Project name**: `dreambig-nas-mcp`. **Path**: the folder from step 6 (`/docker/dreambig-nas-mcp`). **Source**: **Create docker-compose.yml** and paste the contents of [`compose.yaml`](compose.yaml) from this repo. In the editor, replace the example `volumes:` lines with one line per Mount from step 1, `<NAS path>:/data/<Mount name>`, adding `:ro` for a read-only Mount:

   ```yaml
       volumes:
         - /volume1/agents:/data/agents
         - /volume1/photos:/data/photos:ro
   ```

   Next.
4. **Web portal settings**: leave Web Station off. Next.
5. Review, tick **Start the project once it is created**, **Done**. Container Manager pulls the image and starts the container. A compose error naming `NAS_MCP_UID` or `NAS_MCP_GID` means `.env` is missing from the Project folder or lacks that value.
6. If the DSM firewall is on (**Control Panel > Security > Firewall**), add a rule allowing TCP `NAS_MCP_HOST_PORT` from your LAN subnet only.

Adding or removing a Mount later: **Project >** `dreambig-nas-mcp` **> Action > Stop**, **YAML configurations** (or **Edit**), change the `volumes:` lines, save, then **Action > Build**.

Updating later: **Container Manager > Image** shows **Update available** on `ghcr.io/azthrun/dreambig-nas-mcp`; click it, or **Project >** `dreambig-nas-mcp` **> Action > Stop**, then **Action > Build** to pull and recreate.

### 8. Check health

1. **Container Manager > Container**: the `dreambig-nas-mcp-nas-mcp-1` container shows **Running** and, after ~15 s, healthy (compose healthcheck on `/healthz` every 30 s).
2. On the Mac: `curl http://192.168.1.10:8080/healthz` prints `{"status":"ok"}`.
3. Auth check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.1.10:8080/mcp` prints `401` (no token rejected).
4. If the container keeps restarting, open its log (**Container > select > Details > Log**). Startup errors read `Config error: ...`, e.g. the token is unset, a folder under `/data` is not a mount point (a container path like `/data/a/b` nests a Mount; the old v1 line mounts one folder at `/data` itself, see [Migrating from v1](#migrating-from-v1-single-root)), a Mount name is reserved (starts with `.`, `@eaDir`, `#recycle`, ...), or `nas-mcp` lacks permission on a shared folder. A line `"type":"warning"` naming a Mount means the server can't write to it and treats it as read-only: grant `nas-mcp` Read/Write in DSM, or add `:ro` if that is what you want.
5. The startup line `"type":"listening"` lists the Mounts, with `(read-only)` after read-only ones.

### 9. Remote access (Tailscale, optional)

To use the server from the Mac away from home, put the NAS and the Mac on a [Tailscale](https://tailscale.com) tailnet. No router port is opened and the server stays unchanged: same port, same bearer token ([ADR-0002](docs/adr/0002-lan-only-static-bearer-token.md)). Only clients that run on the Mac (Claude Code, Claude Desktop via `mcp-remote`) can use it; claude.ai web/mobile and Desktop's built-in Connectors connect from Anthropic's cloud and can't join a tailnet. Below, `<port>` is your `NAS_MCP_HOST_PORT`.

1. **Tailnet.** Open `https://login.tailscale.com/start` and sign in with an account that has 2FA on (GitHub, Google, Apple); that account is the key to the tailnet.
2. **Mac.** Install Tailscale from the Mac App Store, open it, menu bar icon **> Log in** with the same account, **Allow** the VPN configuration. In its settings tick **Launch at login** (the Mac must be on the tailnet to reach the server, at home too).
3. **NAS.** Open DSM by its LAN address (`http://192.168.1.10:5000`), not QuickConnect: the package refuses to open over QuickConnect. **Package Center >** search `Tailscale` **> Install > Open**, log in with the same account **> Connect**. Fallback if it won't open: SSH in (step 3, option A), run `sudo tailscale up`, open the printed URL on the Mac.
4. **Admin console** (`https://login.tailscale.com/admin/machines`):
   1. NAS row **> ⋯ > Edit machine name** > `nas`.
   2. NAS row **> ⋯ > Disable key expiry** (otherwise it drops off the tailnet after ~180 days). Leave expiry on for the Mac.
   3. Note both `100.x.y.z` addresses (NAS and Mac).
   4. **DNS** tab: **MagicDNS** enabled; note the **Tailnet name** (`<tailnet>.ts.net`). The NAS is now `nas.<tailnet>.ts.net`.
5. **Access controls** (console **> Access controls > JSON editor**). The default policy lets every device reach every port on every other device. Copy it somewhere as a backup, then replace it with the policy below (fill in the two addresses and `<port>`) and **Save**. Only the Mac can then reach the NAS, only on the server's port; DSM (5000/5001) is not reachable over the tailnet, use the LAN for DSM admin.

   ```json
   {
     "hosts": {
       "macbook": "<mac 100.x.y.z>",
       "nas": "<nas 100.x.y.z>"
     },
     "acls": [
       { "action": "accept", "src": ["macbook"], "dst": ["nas:<port>"] }
     ],
     "ssh": []
   }
   ```

6. **Check from the Mac**, once at home and once on another network (e.g. a phone hotspot):
   - `curl http://nas.<tailnet>.ts.net:<port>/healthz` prints `{"status":"ok"}`.
   - `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://nas.<tailnet>.ts.net:<port>/mcp` prints `401`.
   - `curl -m 5 http://nas.<tailnet>.ts.net:5000` times out (the policy blocks DSM).
   - `Could not resolve host`: wrong tailnet name or MagicDNS off. A fast `Couldn't connect`: the NAS was reached but nothing listens on that port (check `<port>` is your `NAS_MCP_HOST_PORT`, in the policy too). A timeout on `<port>`: the policy blocks it, or the DSM firewall does (allow TCP `<port>` from `100.64.0.0/10`).
7. **Clients.** Use `http://nas.<tailnet>.ts.net:<port>/mcp` as the URL in [Client setup](#client-setup), at home and away. To switch an existing Claude Code entry: `claude mcp remove nas -s user`, then `claude mcp add` again with the new URL. For Claude Desktop, replace the URL in `claude_desktop_config.json` and restart it.

Plain `http://` is fine here: tailnet traffic is end-to-end encrypted by WireGuard. Request path from Mac to container: [docs/network-flow.md](docs/network-flow.md).

## Client setup

Replace `192.168.1.10:8080` with your NAS IP and `NAS_MCP_HOST_PORT` (or `nas.<tailnet>.ts.net:<port>` with [Tailscale](#9-remote-access-tailscale-optional)), and `<token>` with the token from step 4.

### Claude Code

```sh
claude mcp add --transport http --scope user nas http://192.168.1.10:8080/mcp \
  --header "Authorization: Bearer <token>"
```

`--scope user` makes it available in every project (drop it for the current project only). Check with `claude mcp list`, or `/mcp` inside Claude Code. The token is stored in plain text in `~/.claude.json`.

### Claude Desktop

Desktop's built-in Connectors connect from Anthropic's cloud and can't reach a LAN-only server, so use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge (a local stdio process; needs Node.js 18+ on the Mac, e.g. `brew install node`).

1. Claude Desktop > **Settings > Developer > Edit Config** (opens `~/Library/Application Support/Claude/claude_desktop_config.json`).
2. Add (merge into an existing `mcpServers` if there is one):

   ```json
   {
     "mcpServers": {
       "nas": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote@latest",
           "http://192.168.1.10:8080/mcp",
           "--transport",
           "http-only",
           "--allow-http",
           "--header",
           "Authorization:${AUTH_HEADER}"
         ],
         "env": {
           "AUTH_HEADER": "Bearer <token>"
         }
       }
     }
   }
   ```

   - `--allow-http` is required: `mcp-remote` refuses plain `http://` URLs that aren't localhost without it.
   - `Authorization:${AUTH_HEADER}` (no space after `:`) with the space inside the env var avoids a known argument-splitting bug in some clients.
   - To keep the token out of the process list, use `"--header-file", "/Users/<you>/.config/nas-mcp-headers.txt"` instead of `--header`, with that file containing the single line `Authorization: Bearer <token>` (`chmod 600` it).
   - Claude Desktop doesn't inherit your shell `PATH`, so a bare `npx` fails if Node isn't in `/usr/local/bin` or `/opt/homebrew/bin` (e.g. installed via nvm). Set `"command"` to the absolute path from `which npx`, and add `"PATH": "<node bin dir>:/usr/bin:/bin"` to `"env"` (the directory containing that `npx`). Update both after upgrading Node.
3. Quit Claude Desktop completely (Cmd-Q) and reopen. The `nas` tools appear under the tools/connectors menu in a new chat. Logs: `~/Library/Logs/Claude/mcp-server-nas.log`.

## Settings

All settings are env vars, read at startup; the server refuses to start with a clear `Config error` if one is missing or invalid (including a token that is still the placeholder or shorter than 16 characters). It also refuses to run as root (UID 0). Copy [`.env.example`](.env.example) to `.env` (it lists every one of them). Sizes are in bytes.

| Env var | Default | Meaning |
| --- | --- | --- |
| `NAS_MCP_TOKEN` | (required) | Bearer token every `/mcp` request must send as `Authorization: Bearer <token>`. Generate with `openssl rand -hex 32`. At least 16 characters; the `.env.example` placeholder is refused. |
| `NAS_MCP_ROOT` | (required; compose: `/data`) | The Root as seen inside the container: every folder under it is a Mount. Fixed by `compose.yaml`; set only when running outside the container. The Mounts themselves are `volumes:` lines in `compose.yaml`. |
| `NAS_MCP_REQUIRE_MOUNT_POINTS` | `true` | Every folder under the Root must be its own mount point (catches the v1 single-folder layout and nested container paths in `volumes:` lines). Set `false` only to run outside the container with plain folders as Mounts. |
| `NAS_MCP_PORT` | `8080` | Listen port inside the container (`0` = pick a free port). Fixed by `compose.yaml`. |
| `NAS_MCP_HOST` | `0.0.0.0` | Listen address. Fixed by `compose.yaml`. |
| `NAS_MCP_HIDDEN_PATTERNS` | (empty) | Extra Hidden Entry globs, comma-separated. No `/` = entry name at any depth (`*.tmp`, `private`); with `/` = Root-relative Path, starting with the Mount (`agents/family/taxes`). `*` does not match dotfiles (use `.*`). |
| `NAS_MCP_READ_TEXT_MAX_BYTES` | `10485760` (10 MB) | Max text `read` (whole file or one offset/limit part) and max PDF file size. |
| `NAS_MCP_READ_IMAGE_MAX_BYTES` | `20971520` (20 MB) | Max image file size for `read`. |
| `NAS_MCP_SEARCH_MAX_RESULTS` | `100` | Max results per `search` call (1-10000); the result says when it was truncated. |
| `NAS_MCP_GREP_MAX_FILE_BYTES` | `5242880` (5 MB) | Content search skips files larger than this. |
| `NAS_MCP_TRASH_RETENTION_DAYS` | `30` | Trash entries older than this many days are permanently removed; `0` = keep forever. |
| `NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS` | `3600` | Seconds between Trash purges while running (also purged at startup). |
| `NAS_MCP_UID` | (required, compose only) | UID of the dedicated DSM user the container runs as (never `0`). |
| `NAS_MCP_GID` | (required, compose only) | GID the container runs as (e.g. `100` = `users`). |
| `NAS_MCP_HOST_PORT` | `8080` (compose only) | NAS port mapped to the container's port 8080. |

## Safety model

- **Root sandbox.** Every Path is relative to the Root and starts with a Mount. `..`, absolute paths, and symlinks resolving outside the Mounts are refused. The container runs as the dedicated DSM user, so DSM permissions are a second fence.
- **Mounts.** The top level is read-only: agents can't create, rename or delete a Mount or put files beside the Mounts. Read-only Mounts refuse every change, even through a symlink. `move` works only within one Mount (between Mounts: read, write, delete).
- **Trash instead of delete.** `delete`, overwriting `write`/`move`, and `edit` move the old content to `<Mount>/.nas-mcp-trash/<YYYY-MM-DD>/<original Path inside the Mount>` at the top of its Mount (name clashes get ` (2)`, ` (3)`, ...). Synology's own `#recycle` does not catch deletes made from inside a container, which is why this exists. Trash entries are purged after `NAS_MCP_TRASH_RETENTION_DAYS`; until then they still use disk space. The date folder is the container's local date, which is UTC unless you set `TZ`.
- **Hidden Entries.** The Trash, `@eaDir`, `#recycle`, `#snapshot`, `.DS_Store`, and anything matching `NAS_MCP_HIDDEN_PATTERNS` never appear in `list`/`search` and are refused by every tool. Names and patterns match case-insensitively and after Unicode NFC normalisation (`@EADIR`, `Family/TAXES` are hidden too), and a Path is checked by where it really lands (a symlink to the Root cannot be used to write into the Trash). Agents cannot see or restore from Trash.
- **Crash-safe writes.** `write` and `edit` write a temp file next to the target (`.<name>.nas-mcp-tmp-<hex>`), sync it, put the old version in the Trash as a hard link (the original stays in place), then rename the temp file over the target in one step, so a crash leaves either the old or the new version, never neither. Temp files left by a crash are removed (and audited) at the next startup.
- **One change at a time.** All changes to the Mounts (write, edit, mkdir, move, delete, Trash purge) run one after another inside the server, and nothing placed in the Trash ever replaces an existing Trash entry. Changes made to the Root from outside the server (SMB, File Station) while a call runs are only partly guarded against; avoid reorganising folders while an agent is working in them.
- **Client prompts.** `delete`, `move`, `write` and `edit` carry MCP `destructiveHint`; read tools carry `readOnlyHint`, so clients can ask you before Destructive Operations.
- **Audit log.** Every write and Destructive Operation (including failed ones), every rejected request (bad token, Path escape, Hidden Entry), every Trash purge and every startup temp-file cleanup is one JSON line on stdout (`"type":"audit"`, `time`, `tool`, `paths`, `result`, `trashed`). View it in **Container Manager > Container >** `dreambig-nas-mcp-nas-mcp-1` **> Details > Log** (or **Project >** `dreambig-nas-mcp` **> Details > Log**).

### Restore something from Trash

1. **File Station > Settings > General**: tick **Show hidden files**, OK (the Trash folder starts with `.`).
2. Open the Mount's shared folder (e.g. `agents`) **> .nas-mcp-trash >** the date it was deleted or overwritten. The audit log's `trashed` field gives the exact Path, starting with the Mount (e.g. `agents/.nas-mcp-trash/2026-10-17/notes/plan.md`).
3. Find the item under its original Path, right-click **> Move to** (or **Copy to**) and pick its original folder. If something with that name exists there now, rename one of them first.
4. Optionally untick **Show hidden files** again.

## Migrating from v1 (single Root)

v2 serves Mounts instead of one Root folder, and agent Paths now start with the Mount name. With `agents` as your old Root folder:

1. **Container Manager > Project >** `dreambig-nas-mcp` **> Action > Stop**. Don't update the image yet (no **Image > Update available**): v2 refuses to start on the old volume line, so the container would keep restarting.
2. Open **YAML configurations** (or **Edit**). Replace the old volume line `- "${NAS_MCP_ROOT_HOST_PATH:...}:/data"` with `- /volume1/agents:/data/agents` (your old `NAS_MCP_ROOT_HOST_PATH` value, then `:/data/<Mount name>`). Add a line for any other shared folder (step 1); give `nas-mcp` access to it in DSM (step 2). Save.
3. In the Project folder's `.env` (File Station, **Show hidden files**), delete the `NAS_MCP_ROOT_HOST_PATH` line. Change any `NAS_MCP_HIDDEN_PATTERNS` entry that contains `/` to start with the Mount name (`family/taxes` becomes `agents/family/taxes`).
4. **Project >** `dreambig-nas-mcp` **> Action > Build**: this pulls the v2 `:latest` image and recreates the container. Then check health (step 8). The startup log line `"type":"listening"` must list your Mounts.
5. Your existing Trash (`agents/.nas-mcp-trash`) stays where it is and keeps being purged; nothing in it moves.
6. Paths change for agents: `notes/plan.md` is now `agents/notes/plan.md`. Update any saved prompts, CLAUDE.md notes or scripts that name Paths.

## Development

Node 24, TypeScript, `@modelcontextprotocol/sdk`.

```sh
npm ci
npm test          # builds dist/ and runs the integration tests (MCP over HTTP against a temp Root)
npm run typecheck
mkdir -p /tmp/root/docs   # each folder under the Root is a Mount
NAS_MCP_TOKEN="$(openssl rand -hex 32)" NAS_MCP_ROOT=/tmp/root NAS_MCP_REQUIRE_MOUNT_POINTS=false npm run dev
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs tests and an image smoke test on every PR, and pushes the image to GHCR only when a GitHub release with a `v*` tag is published.
