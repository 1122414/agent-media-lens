# Implementation status

Public repository, default branch main and Apache-2.0 verified. Phase 0 source inspection is complete. Node 24.16, pnpm 11.5, Python 3.12.7, FFmpeg 8.1.1, Git and GitHub CLI are available. Docker CLI is installed, the Compose plugin is missing and Colima is stopped. A local faster-whisper base model cache exists.

Provider authentication and live media acceptance are pending. The repository has no release. See the implementation plan for stage gates.

Phase 1: workspace dependencies locked. Strict build, ESLint and provider tests passed. Native resolution of a real public short link identified a photo note. Live Evil0ctal authorization and video download remain pending. Compose and Colima are now available.

Phase 2: FFmpeg, local CPU base ASR, adaptive sampling, JPEG output and Tesseract ran on generated English and Mandarin tutorial clips. Both identified the spoken instructions and the frame labels. Two pytest tests passed (including no audio), plus Ruff and strict mypy. CUDA and a live platform video remain unverified.

Phase 3: SQLite task stages, admission limits, file expiry, interrupted-process recovery and structured artifacts are implemented. Integration checks exercised one real generated MP4 through the worker, returned JPEG bytes, rejected concurrent admission and verified original-only cleanup. TypeScript suite: 14 passed.

Phase 4: CLI launchers installed; Codex lists the local plugin as installed and enabled. The SDK integration test returned real JPEG bytes. A fresh Codex CLI session loaded the skill, called six installed tools including media_get_frame (image), described the white card and black lettering in the English fixture, cited the spoken instruction and wrote analysis.md through media_save_analysis. This acceptance used a generated local fixture.

Phase 5: both Compose configurations validated. The core container built locally; CLI help and faster-whisper import ran inside it. The independent upstream 5.1.11 API, worker, Redis and PostgreSQL started; /readyz succeeded and /api/setup/status showed an uninitialized owner. The supplied real short link resolved to a note, with CLI resolve returning UNSUPPORTED_MEDIA. Public video acquisition still requires a configured guest-only provider and eligible video. CI results are available on GitHub Actions; no release tag has been created.
