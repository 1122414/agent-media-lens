#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for tool in pnpm uv ffmpeg ffprobe tesseract; do command -v "$tool" >/dev/null || { echo "Missing $tool. For Docker setup run ./media-lens install." >&2; exit 1; }; done
pnpm install --frozen-lockfile
uv sync --frozen --python 3.12
pnpm build
sh scripts/install-launchers.sh "${MEDIA_LENS_BIN_DIR:-$HOME/.local/bin}"
