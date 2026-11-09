#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${1:-"$HOME/.local/bin"}
test -f "$root/dist/apps/cli/main.js" && test -f "$root/dist/apps/mcp-server/main.js" || { echo "Run pnpm build first" >&2; exit 1; }
mkdir -p "$target"
link() {
  if [ -L "$target/$2" ] && [ "$(readlink "$target/$2")" = "$1" ]; then return; fi
  if [ -e "$target/$2" ] || [ -L "$target/$2" ]; then echo "Already exists: $target/$2" >&2; exit 1; fi
  ln -s "$1" "$target/$2"
}
chmod +x "$root/dist/apps/cli/main.js" "$root/dist/apps/mcp-server/main.js"
link "$root/dist/apps/cli/main.js" media-lens
link "$root/dist/apps/mcp-server/main.js" media-lens-mcp
