# LAN-only with a static bearer token; no OAuth, no public exposure

The server is reachable only on the home LAN (remote access, if ever, via Tailscale) and authenticates every request with a single static bearer token from an env var. The only intended clients are Claude Code and Claude Desktop (via `mcp-remote`) on the owner's Mac, so OAuth and a public HTTPS endpoint would add attack surface and complexity for no user.

## Considered Options

- **Public HTTPS + OAuth via DSM reverse proxy**: required for claude.ai web/mobile custom connectors (they connect from Anthropic's cloud). Rejected for now: exposes a read/write/delete file API to the internet. Revisit if web/mobile access becomes a real need.
