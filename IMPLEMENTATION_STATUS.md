# Implementation status

Public repository, default branch main and Apache-2.0 verified. Phase 0 source inspection is complete. Node 24.16, pnpm 11.5, Python 3.12.7, FFmpeg 8.1.1, Git and GitHub CLI are available. Docker CLI is installed, the Compose plugin is missing and Colima is stopped. A local faster-whisper base model cache exists.

**Current release gate (2026-11-09):** local Evil0ctal authentication and guest setup are verified. An authorized test link resolved to a public video and played in a fresh guest browser (28 seconds). The v5 API returned `UPSTREAM_RISK_CONTROL` for that video. No video was downloaded and no transcript, frames, OCR or Markdown were produced for it. Positive live acquisition remains unverified; v0.1.0 is untagged.

The following entries record earlier stage results.

Phase 1: workspace dependencies locked. Strict build, ESLint and provider tests passed. Native resolution of a real public short link identified a photo note. Live Evil0ctal authorization and video download remain pending. Compose and Colima are now available.

Phase 2: FFmpeg, local CPU base ASR, adaptive sampling, JPEG output and Tesseract ran on generated English and Mandarin tutorial clips. Both identified the spoken instructions and the frame labels. Two pytest tests passed (including no audio), plus Ruff and strict mypy. CUDA and a live platform video remain unverified.

Phase 3: SQLite task stages, admission limits, file expiry, interrupted-process recovery and structured artifacts are implemented. Integration checks exercised one real generated MP4 through the worker, returned JPEG bytes, rejected concurrent admission and verified original-only cleanup. TypeScript suite: 14 passed.

Phase 4: CLI launchers installed; Codex lists the local plugin as installed and enabled. The SDK integration test returned real JPEG bytes. A fresh Codex CLI session loaded the skill, called six installed tools including media_get_frame (image), described the white card and black lettering in the English fixture, cited the spoken instruction and wrote analysis.md through media_save_analysis. This acceptance used a generated local fixture.

Phase 5: both Compose configurations validated. The core container built locally; CLI help and faster-whisper import ran inside it. The independent upstream 5.1.11 API, worker, Redis and PostgreSQL started; /readyz succeeded and /api/setup/status showed an uninitialized owner. The supplied real short link resolved to a note, with CLI resolve returning UNSUPPORTED_MEDIA. Public video acquisition still requires a configured guest-only provider and eligible video. CI results are available on GitHub Actions; no release tag has been created.

Public CI build and checks passed on 97108fd after pinning the published setup-uv commit. npm production audit reported no known vulnerabilities. Per-task discarding, abortable transfers, dangling-link rejection and pre-read image size checks are covered in the hardening stage.

Additional regression checks passed for an orphan worker, bounded download retries, declared and chunked response ceilings, partial-file removal and exclusive creation. Latest local totals: 17 TypeScript and two Python tests. A separate clean checkout successfully installed both lockfiles, built, tested and ran its own launcher.

Provider diagnostics: on the live loopback instance, a valid read-only key and zero identities now produce exit 1 with `IDENTITY_POOL_EXHAUSTED`. After a guest-only import, doctor exited 0 with one available identity; resolving the video still reported the platform refusal and stopped. Immediate and queued errors, wrong scope, missing or rejected keys, reserved identities and redaction are covered by the offline suite (29 TypeScript tests total).
