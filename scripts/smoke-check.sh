#!/usr/bin/env bash
# HTTP smoke checks against a running server with a Mount "smoke" containing smoke-hello.txt.
# Usage: SMOKE_TOKEN=<token> scripts/smoke-check.sh <base-url>
# Checks: GET /healthz is open and ok; /mcp rejects a missing token;
# an authenticated `list` tool call sees smoke-hello.txt;
# listing the virtual Root reports the `smoke` Mount (mounted :ro) with readOnly true.
set -euo pipefail

base_url="${1:?usage: SMOKE_TOKEN=<token> $0 <base-url>}"
token="${SMOKE_TOKEN:?SMOKE_TOKEN is not set}"

fail() { echo "smoke: FAIL: $*" >&2; exit 1; }

health="$(curl -fsS "$base_url/healthz")" || fail "GET /healthz did not return 2xx"
[[ "$health" == *'"status":"ok"'* ]] || fail "GET /healthz returned: $health"
echo "smoke: ok: /healthz"

status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base_url/mcp" \
  -H 'content-type: application/json' -d '{}')"
[[ "$status" == "401" ]] || fail "POST /mcp without token returned $status, want 401"
echo "smoke: ok: /mcp rejects missing token"

# Stateless server: a tools/call needs no prior initialize/session.
call='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list","arguments":{"path":"smoke"}}}'
result="$(curl -fsS -X POST "$base_url/mcp" \
  -H "authorization: Bearer $token" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$call")" || fail "authenticated tools/call failed"
[[ "$result" == *'smoke-hello.txt'* ]] || fail "list result lacks smoke-hello.txt: $result"
[[ "$result" != *'"isError":true'* ]] || fail "list returned an error: $result"
echo "smoke: ok: authenticated list tool call"

# The `smoke` Mount is bind-mounted :ro, so listing the virtual Root must flag it read-only.
# Match the unescaped structuredContent entry (the text copy is escaped JSON, so it cannot match).
call='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list","arguments":{"path":""}}}'
result="$(curl -fsS -X POST "$base_url/mcp" \
  -H "authorization: Bearer $token" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$call")" || fail "authenticated Root list tools/call failed"
[[ "$result" != *'"isError":true'* ]] || fail "Root list returned an error: $result"
ro_entry='"name":"smoke","type":"folder"[^}]*"readOnly":true'
[[ "$result" =~ $ro_entry ]] || fail "Root list does not report the smoke Mount as readOnly: $result"
echo "smoke: ok: :ro Mount reported read-only"
