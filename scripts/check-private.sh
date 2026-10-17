#!/bin/sh
# Blocks a commit whose staged additions contain any line of .private-denylist
# (gitignored: real NAS IP, tailnet name, DDNS host, username...). One fixed string per line.
set -eu
list=.private-denylist
[ -s "$list" ] || exit 0
hits=$(git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++' | grep -iF -f "$list" || true)
if [ -n "$hits" ]; then
  echo "check-private: staged changes contain private values from $list:" >&2
  echo "$hits" >&2
  echo "Replace them with placeholders (see .env.example)." >&2
  exit 1
fi
