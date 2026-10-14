# dreambig-nas-mcp

## Safety

- NAS operations that delete, move, or overwrite files → confirm first, list exactly what is affected.
- NAS host/credentials via env vars only; keep a `.env.example` with placeholder values.

## Agent skills

### Issue tracker

GitHub Issues on azthrun/dreambig-nas-mcp via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
