# LAN-only with a static bearer token; no OAuth, no public exposure

The server is reachable only on the home LAN (remote access, if ever, via Tailscale) and authenticates every request with a single static bearer token from an env var. The only intended clients are Claude Code and Claude Desktop (via `mcp-remote`) on the owner's Mac, so OAuth and a public HTTPS endpoint would add attack surface and complexity for no user.

## Considered Options

- **Public HTTPS + OAuth via DSM reverse proxy**: required for claude.ai web/mobile custom connectors (they connect from Anthropic's cloud). Rejected for now: exposes a read/write/delete file API to the internet. Revisit if web/mobile access becomes a real need.
- **Synology VPN Server (OpenVPN) for remote access**: fully self-hosted, but needs a router port-forward, which puts an internet-facing service on the NAS. Rejected in favour of Tailscale (no open port).

## Revisited 2026-10-16: remote access

Off-LAN access from the owner's Mac turned out to be needed; claude.ai web/mobile still is not. Chosen: Tailscale (DSM package) with the server unchanged, so remote access needs no code and no public endpoint. The tailnet policy lets only the Mac reach the NAS, only on the server's port; the NAS node has key expiry disabled; traffic stays plain HTTP inside WireGuard. Public HTTPS + OAuth was reconsidered and rejected again for the same reason as above. Setup: README, "Remote access (Tailscale, optional)".
