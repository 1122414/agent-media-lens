# Technology decisions

Node 24 LTS supplies native SQLite, streams and subprocesses. TypeScript runs in strict mode. Zod validates input and worker results. The official MCP SDK offers stdio and image content. Commander supplies CLI parsing. Vitest and ESLint verify the TypeScript layer.

Python 3.12 runs faster-whisper on CTranslate2. Prefer CPU int8 on this Mac and probe CUDA on compatible devices. FFmpeg decodes audio and frames. Tesseract has both English and Simplified Chinese data on the development host. Model weights stay outside Git. Pytest, Ruff and mypy check the worker.

## Upstream contract

Inspected Evil0ctal commit [d44264e](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/tree/d44264e96cae55a6df341ed4a0b81b3e2d1fbcaf), dated 2026-11-07. Its LICENSE is Apache-2.0. Use the HTTP API, with independent deployment and no vendored upstream source.

- `src/dtk/api/routes/content.py` registers GET /api/v1/{platform}/video. The worker resolves short links. Read access needs douyin:read. Query options include raw platform data, which the adapter needs to verify explicit public visibility.
- `src/dtk/api/routes/operations.py` and `tasks.py` distinguish 200 responses from accepted work. Poll GET /api/v1/tasks/{uuid} for queued work. Key goes only in the operator endpoint request header. Never request identity selection or explain mode.
- `src/dtk/platforms/douyin/parser.py` maps missing private_status to public in its normalized output. Require explicit raw public status and refuse unavailable or download-restricted media.
- `src/dtk/mcp/tools.py` includes parse_url, get_video, get_task_result, download_media and transcribe_video. These are separate from this project's local evidence tools.
- `docker/compose.yml` exposes only the API on loopback by default, with /readyz and a separate worker, PostgreSQL/TimescaleDB, migrations and Redis. The deployment must have a usable guest identity for public reads. A live service and authorized source are required for acceptance.

References: [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Tesseract](https://github.com/tesseract-ocr/tesseract), [Compose](https://docs.docker.com/compose/), [Codex plugins](https://developers.openai.com/codex/plugins), [official marketplace](https://github.com/openai/plugins).
