# dreambig-nas-mcp

An MCP server that runs in a container on a Synology NAS and lets agents (Claude Code, Claude Desktop) read and manage files inside one NAS folder, the **Root**. Nothing outside the Root is visible.

- Tools: `list`, `stat`, `read` (text, PDF text, images), `search` (name glob + optional content grep), `write`, `edit`, `mkdir`, `move`, `delete`.
- Transport: Streamable HTTP at `http://<nas>:<port>/mcp`, LAN only, one static bearer token ([ADR-0002](docs/adr/0002-lan-only-static-bearer-token.md)).
- Nothing is ever really deleted by an agent: deleted and overwritten content goes to a Trash folder inside the Root ([ADR-0001](docs/adr/0001-delete-moves-to-trash.md)).
- Vocabulary (Root, Path, Trash, Hidden Entry, Destructive Operation): [GLOSSARY.md](GLOSSARY.md).

Target: DS220+ (Intel, `linux/amd64`), DSM 7.4.1, Container Manager.

## Synology setup

You need: DSM admin access, a Mac on the same LAN, and the NAS's LAN IP address (Control Panel > Network > Network Interface, e.g. `192.168.1.10`). Below, `agents` is the example shared folder used as the Root and `nas-mcp` the example DSM user; use your own names.

### 1. Choose or create the Root's shared folder

1. DSM > **Control Panel > Shared Folder**.
2. Either pick an existing shared folder, or click **Create > Create Shared Folder**, name it (e.g. `agents`), pick the volume (e.g. Volume 1), and finish the wizard (you can leave encryption and advanced options off).
3. Note its NAS path: `/volume1/agents` (volume number + folder name). You can also use a sub-folder, e.g. `/volume1/agents/claude`; the agent sees only what is mounted.

### 2. Create a dedicated DSM user

1. **Control Panel > User & Group > User > Create**.
2. Name: `nas-mcp`. Set a long random password (nobody needs to log in as this user). Tick **Disallow the user to change account password**. Next.
3. **Join groups**: leave only `users`. Next.
4. **Assign shared folders permissions**: tick **Read/Write** for `agents` only; tick **No access** for every other shared folder. Next.
5. **Assign user quota**: skip. Next.
6. **Assign application permissions**: tick **Deny** for every application (the container does not need DSM apps). Next.
7. **Set user speed limit**: skip. Next, **Done**.
8. Check: **Control Panel > Shared Folder >** select `agents` **> Edit > Permissions** shows `nas-mcp` with Read/Write. If you picked an existing folder, also make sure no group gives `nas-mcp` access to other folders (the `users` group's permissions apply to it too: check **User & Group > Group > users > Edit > Permissions**).

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

On the Mac: `openssl rand -hex 32`. Copy the 64-character output; it is `NAS_MCP_TOKEN` below and goes into each client config. Treat it like a password (anyone on the LAN who has it can read and change files in the Root). To rotate it later, change it in `.env`, rebuild the Project (step 7), and update the clients.

### 5. Image access (GHCR)

The image is `ghcr.io/azthrun/dreambig-nas-mcp:latest` (`linux/amd64`), built and pushed by CI on every push to `main`. It contains no secrets.

- **Public package (recommended, no login on the NAS).** Once, on github.com: your profile > **Packages > dreambig-nas-mcp > Package settings > Danger Zone > Change visibility > Public**. Check: on the Mac, `docker pull ghcr.io/azthrun/dreambig-nas-mcp:latest` works without `docker login` (or open `https://github.com/users/azthrun/packages/container/package/dreambig-nas-mcp` in a private browser window).
- **Private package.** Create a GitHub **classic** personal access token with only the `read:packages` scope (github.com > Settings > Developer settings > Personal access tokens > Tokens (classic) > Generate new token). Then over SSH on the NAS (step 3, option A): `sudo docker login ghcr.io -u <github-user>` and paste the token as the password. Container Manager's engine then uses those credentials for `ghcr.io` pulls.

### 6. Prepare the Project folder and `.env`

1. **File Station**: create a folder for the Project, e.g. `docker/dreambig-nas-mcp` (create the `docker` shared folder first if you don't have one). Do not put it inside the Root.
2. On the Mac, copy [`.env.example`](.env.example) from this repo to a file named `env.txt` and fill in:
   - `NAS_MCP_TOKEN` = the token from step 4
   - `NAS_MCP_UID`, `NAS_MCP_GID` = the numbers from step 3
   - `NAS_MCP_ROOT_HOST_PATH` = the Root's NAS path from step 1, e.g. `/volume1/agents`
   - `NAS_MCP_HOST_PORT` = a free port on the NAS (default `8080`; DSM itself uses 5000/5001)
   - Leave `NAS_MCP_ROOT`, `NAS_MCP_PORT`, `NAS_MCP_HOST` as they are (compose fixes them). Other settings: see [Settings](#settings).
3. In File Station, upload `env.txt` into `docker/dreambig-nas-mcp`, then right-click it > **Rename** to `.env`. (File Station hides dot-files unless **Settings > General > Show hidden files** is ticked; the file is still there.)
4. Keep `.env` out of git and out of any folder agents can see.

### 7. Create the Container Manager Project

1. Install **Container Manager** from Package Center if it isn't installed.
2. **Container Manager > Project > Create**.
3. **Project name**: `dreambig-nas-mcp`. **Path**: the folder from step 6 (`/docker/dreambig-nas-mcp`). **Source**: **Upload compose.yaml / docker-compose.yml** and pick [`compose.yaml`](compose.yaml) from this repo (or **Create docker-compose.yml** and paste its contents). Next.
4. **Web portal settings**: leave Web Station off. Next.
5. Review, tick **Start the project once it is created**, **Done**. Container Manager pulls the image and starts the container. A compose error naming `NAS_MCP_UID`, `NAS_MCP_GID` or `NAS_MCP_ROOT_HOST_PATH` means `.env` is missing from the Project folder or lacks that value.
6. If the DSM firewall is on (**Control Panel > Security > Firewall**), add a rule allowing TCP `NAS_MCP_HOST_PORT` from your LAN subnet only.

Updating later: **Container Manager > Image** shows **Update available** on `ghcr.io/azthrun/dreambig-nas-mcp`; click it, or **Project >** `dreambig-nas-mcp` **> Action > Stop**, then **Action > Build** to pull and recreate.

### 8. Check health

1. **Container Manager > Container**: the `dreambig-nas-mcp-nas-mcp-1` container shows **Running** and, after ~15 s, healthy (compose healthcheck on `/healthz` every 30 s).
2. On the Mac: `curl http://192.168.1.10:8080/healthz` prints `{"status":"ok"}`.
3. Auth check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.1.10:8080/mcp` prints `401` (no token rejected).
4. If the container keeps restarting, open its log (**Container > select > Details > Log**). Startup errors read `Config error: ...`, e.g. the token is unset or the Root is missing/unreadable (wrong `NAS_MCP_ROOT_HOST_PATH`, or `nas-mcp` lacks permission on the shared folder).

## Client setup

Replace `192.168.1.10:8080` with your NAS IP and `NAS_MCP_HOST_PORT`, and `<token>` with the token from step 4.

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
3. Quit Claude Desktop completely (Cmd-Q) and reopen. The `nas` tools appear under the tools/connectors menu in a new chat. Logs: `~/Library/Logs/Claude/mcp-server-nas.log`.

## Settings

All settings are env vars, read at startup; the server refuses to start with a clear `Config error` if one is missing or invalid (including a token that is still the placeholder or shorter than 16 characters). It also refuses to run as root (UID 0). Copy [`.env.example`](.env.example) to `.env` (it lists every one of them). Sizes are in bytes.

| Env var | Default | Meaning |
| --- | --- | --- |
| `NAS_MCP_TOKEN` | (required) | Bearer token every `/mcp` request must send as `Authorization: Bearer <token>`. Generate with `openssl rand -hex 32`. At least 16 characters; the `.env.example` placeholder is refused. |
| `NAS_MCP_ROOT` | (required; compose: `/data`) | The Root as seen inside the container. Fixed by `compose.yaml`; set only when running outside the container. |
| `NAS_MCP_PORT` | `8080` | Listen port inside the container (`0` = pick a free port). Fixed by `compose.yaml`. |
| `NAS_MCP_HOST` | `0.0.0.0` | Listen address. Fixed by `compose.yaml`. |
| `NAS_MCP_HIDDEN_PATTERNS` | (empty) | Extra Hidden Entry globs, comma-separated. No `/` = entry name at any depth (`*.tmp`, `private`); with `/` = Root-relative Path (`family/taxes`). `*` does not match dotfiles (use `.*`). |
| `NAS_MCP_READ_TEXT_MAX_BYTES` | `10485760` (10 MB) | Max text `read` (whole file or one offset/limit part) and max PDF file size. |
| `NAS_MCP_READ_IMAGE_MAX_BYTES` | `20971520` (20 MB) | Max image file size for `read`. |
| `NAS_MCP_SEARCH_MAX_RESULTS` | `100` | Max results per `search` call (1-10000); the result says when it was truncated. |
| `NAS_MCP_GREP_MAX_FILE_BYTES` | `5242880` (5 MB) | Content search skips files larger than this. |
| `NAS_MCP_TRASH_RETENTION_DAYS` | `30` | Trash entries older than this many days are permanently removed; `0` = keep forever. |
| `NAS_MCP_TRASH_PURGE_INTERVAL_SECONDS` | `3600` | Seconds between Trash purges while running (also purged at startup). |
| `NAS_MCP_UID` | (required, compose only) | UID of the dedicated DSM user the container runs as (never `0`). |
| `NAS_MCP_GID` | (required, compose only) | GID the container runs as (e.g. `100` = `users`). |
| `NAS_MCP_ROOT_HOST_PATH` | (required, compose only) | NAS folder bind-mounted as the Root, e.g. `/volume1/agents`. |
| `NAS_MCP_HOST_PORT` | `8080` (compose only) | NAS port mapped to the container's port 8080. |

## Safety model

- **Root sandbox.** Every Path is relative to the Root. `..`, absolute paths, and symlinks resolving outside the Root are refused. The container runs as the dedicated DSM user, so DSM permissions are a second fence.
- **Trash instead of delete.** `delete`, overwriting `write`/`move`, and `edit` move the old content to `.nas-mcp-trash/<YYYY-MM-DD>/<original Path>` at the top of the Root (name clashes get ` (2)`, ` (3)`, ...). Synology's own `#recycle` does not catch deletes made from inside a container, which is why this exists. Trash entries are purged after `NAS_MCP_TRASH_RETENTION_DAYS`; until then they still use disk space. The date folder is the container's local date, which is UTC unless you set `TZ`.
- **Hidden Entries.** The Trash, `@eaDir`, `#recycle`, `#snapshot`, `.DS_Store`, and anything matching `NAS_MCP_HIDDEN_PATTERNS` never appear in `list`/`search` and are refused by every tool. Agents cannot see or restore from Trash.
- **Client prompts.** `delete`, `move`, `write` and `edit` carry MCP `destructiveHint`; read tools carry `readOnlyHint`, so clients can ask you before Destructive Operations.
- **Audit log.** Every write and Destructive Operation, every rejected request (bad token, Path escape, Hidden Entry) and every Trash purge is one JSON line on stdout (`"type":"audit"`, `time`, `tool`, `paths`, `result`, `trashed`). View it in **Container Manager > Container >** `dreambig-nas-mcp-nas-mcp-1` **> Details > Log** (or **Project >** `dreambig-nas-mcp` **> Details > Log**).

### Restore something from Trash

1. **File Station > Settings > General**: tick **Show hidden files**, OK (the Trash folder starts with `.`).
2. Open the Root's shared folder (e.g. `agents`) **> .nas-mcp-trash >** the date it was deleted or overwritten. The audit log's `trashed` field gives the exact Trash Path.
3. Find the item under its original Path, right-click **> Move to** (or **Copy to**) and pick its original folder. If something with that name exists there now, rename one of them first.
4. Optionally untick **Show hidden files** again.

## Development

Node 24, TypeScript, `@modelcontextprotocol/sdk`.

```sh
npm ci
npm test          # builds dist/ and runs the integration tests (MCP over HTTP against a temp Root)
npm run typecheck
NAS_MCP_TOKEN="$(openssl rand -hex 32)" NAS_MCP_ROOT=/tmp/root npm run dev
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs tests and an image smoke test on every PR, and pushes the image to GHCR from `main`.
