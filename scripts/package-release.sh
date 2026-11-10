#!/bin/sh
set -eu
version=${1:?version without v}; out=${2:?output directory}; ref=${3:-HEAD}
mkdir -p "$out"
actual=$(git show "${ref}:package.json" | node -p 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).version')
[ "$actual" = "$version" ] || { echo 'Version mismatch' >&2; exit 1; }
git archive --format=tar.gz --prefix="agent-media-lens-v$version/" -o "$out/agent-media-lens-v$version.tar.gz" "$ref"
git archive --format=tar.gz -o "$out/agent-media-lens-codex.tgz" "$ref" .agents/plugins/marketplace.json plugins/codex
git show "${ref}:docs/demo/walkthrough.mp4" > "$out/walkthrough.mp4"
git show "${ref}:docs/demo/captions.zh.vtt" > "$out/captions.zh.vtt"
(cd "$out" && shasum -a 256 agent-media-lens-codex.tgz "agent-media-lens-v$version.tar.gz" walkthrough.mp4 captions.zh.vtt > SHA256SUMS && shasum -a 256 -c SHA256SUMS)
