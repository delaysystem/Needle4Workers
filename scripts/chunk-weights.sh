#!/usr/bin/env bash
# Split a .cact archive into 25 MiB static-asset chunks + sha manifest.
# Usage: scripts/chunk-weights.sh <archive.cact> <chunk-basename>
# Example: scripts/chunk-weights.sh /tmp/handoff_20l.cact needle3-20l-handoff.cact
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <archive.cact> <chunk-basename>" >&2
  exit 1
fi
archive="$1"
base="$2"
dir="$(cd "$(dirname "$0")/../weights" && pwd)"
split -b 26214400 "$archive" "$dir/$base."
# Two-char glob: chunk suffixes only, never the manifest itself.
sha256sum "$dir/$base".?? | sed "s#$dir/##" > "$dir/$base.SHA256SUMS"
cat "$dir/$base".?? | sha256sum | sed "s#  -#  $base (reassembled)#" >> "$dir/$base.SHA256SUMS"
cat "$dir/$base.SHA256SUMS"
