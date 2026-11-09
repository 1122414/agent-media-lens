# Implementation status

The public repository uses Apache-2.0 and the main branch. Node 24.16, pnpm 11.5, Python 3.12.7, FFmpeg 8.1.1, Tesseract, Docker on Colima, standalone Compose and the local CPU Whisper base model were used on the development Mac.

**2026-11-09 verification.** The local Evil0ctal 5.1.11 service returned public details through a complete anonymous guest. The CLI saved a 19.526-second platform download. A separate 28.001-second video had its save button disabled. It completed transcript, frame and OCR processing, and an installed Codex client read actual JPEGs and saved a cited report. An authorized playback export decoded as 1920×1080 H.264/AAC. The English voice lesson and Mandarin software tutorial completed against the actual provider. See [test cases](docs/development/testing.md).

The [v0.1.0 report](docs/releases/v0.1.0.md) lists acceptance checks, installation steps and remaining platform limits. Local release checks passed with 38 TypeScript tests, two Python tests, the compiled Docker CLI and Codex plugin 0.1.0 installed and enabled. Public CI and release publication are recorded by GitHub Actions.

## Historical stage results

Phase 1: workspace dependencies locked. Strict build, ESLint and provider tests passed. Native resolution of a real public short link identified a photo note. Live Evil0ctal authorization and video download remain pending. Compose and Colima are now available.

Phase 2: FFmpeg, local CPU base ASR, adaptive sampling, JPEG output and Tesseract ran on generated English and Mandarin tutorial clips. Both identified the spoken instructions and the frame labels. Two pytest tests passed (including no audio), plus Ruff and strict mypy. CUDA and a live platform video remain unverified.

Phase 3: SQLite task stages, admission limits, file expiry, interrupted-process recovery and structured artifacts are implemented. Integration checks exercised one real generated MP4 through the worker, returned JPEG bytes, rejected concurrent admission and verified original-only cleanup. TypeScript suite: 14 passed.

Phase 4: CLI launchers installed; Codex lists the local plugin as installed and enabled. The SDK integration test returned real JPEG bytes. A fresh Codex CLI session loaded the skill, called six installed tools including media_get_frame (image), described the white card and black lettering in the English fixture, cited the spoken instruction and wrote analysis.md through media_save_analysis. This acceptance used a generated local fixture.

Phase 5: both Compose configurations validated. The core container built locally; CLI help and faster-whisper import ran inside it. The independent upstream 5.1.11 API, worker, Redis and PostgreSQL started; /readyz succeeded and /api/setup/status showed an uninitialized owner. The supplied real short link resolved to a note, with CLI resolve returning UNSUPPORTED_MEDIA. Public video acquisition still requires a configured guest-only provider and eligible video. CI results are available on GitHub Actions; no release tag has been created.

Public CI build and checks passed on 97108fd after pinning the published setup-uv commit. npm production audit reported no known vulnerabilities. Per-task discarding, abortable transfers, dangling-link rejection and pre-read image size checks are covered in the hardening stage.

Additional regression checks passed for an orphan worker, bounded download retries, declared and chunked response ceilings, partial-file removal and exclusive creation. Latest local totals: 17 TypeScript and two Python tests. A separate clean checkout successfully installed both lockfiles, built, tested and ran its own launcher.

Provider diagnostics: on the live loopback instance, a valid read-only key and zero identities now produce exit 1 with `IDENTITY_POOL_EXHAUSTED`. After a guest-only import, doctor exited 0 with one available identity; resolving the video still reported the platform refusal and stopped. Immediate and queued errors, wrong scope, missing or rejected keys, reserved identities and redaction are covered by the offline suite (29 TypeScript tests total).

Local Docker deployment: the rebuilt Core image reached an independently running provider on the same Docker engine via compose.local-provider.yaml. The default isolated container reported providerReady=false. With the override it authenticated, reported providerReady=true and zero available identities, and correctly exited 1. The host status endpoint confirmed one cooling Douyin identity and zero active. The provider's only published port remained bound to 127.0.0.1. No additional platform request was made.
