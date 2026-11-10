# Verification

Run pnpm build, pnpm lint, pnpm test, uv run ruff check workers scripts tests, uv run mypy workers, uv run pytest -q tests, and node scripts/check-plugin.mjs. Build before testing because the stdio test launches the compiled entry point.

For voiced-model quality comparisons, see the [Mandarin CPU experiment and local evaluation recipe](2026-11-10_mandarin-asr-comparison.md). The model weights and reference media are not required for CI.

Tests that start FFmpeg, Tesseract and the real Python worker use a per-case timeout (20–30 seconds). The five-second unit-test default interrupted a mixed-album run on a shared [Linux runner](https://github.com/1122414/agent-media-lens/actions/runs/42589627084/job/129067785112); the frame, OCR, page, byte-budget and cleanup assertions remain mandatory.

Provider fixtures cover URL validation, explicit public/download permission, v5 task polling and image album rejection. The generated FFmpeg clip tests exercise real decoding, frames, OCR, task storage, MCP image bytes and CLI reads without a provider identity. The suite injects a fixture at the acquisition boundary.

A separate manual acceptance used generated Mandarin and English speech with different slides, CPU base and installed Tesseract language packs. English returned the settings and save instructions at 0–4s. Mandarin returned the corresponding spoken instructions at 0–6.8s. A fresh Codex CLI session retrieved the English transcript, read f000 as image content, correctly described white background and black lettering and saved a timestamped report. These runs never fetched a live platform video.

For live acceptance, use public videos you may analyze. Exercise the platform-download and public-playback branches separately, including an authorized playback copy and one-shot disposal. Run identify, resolve and analyze on a fresh cache. Recheck metadata against the share page, inspect the transcript and at least one returned image, and save the report through Codex. Run separately on an expired link, a photo note and a private or restricted item. Record sanitized outcomes, never media, signed URLs or keys.

The installed client called media_get_task, media_get_result, media_get_transcript, media_list_frames, media_get_frame and media_save_analysis. Its frame response contained MCP image content. A direct read of the resulting Markdown confirmed the cited speech and image observations.

## Live acceptance on 2026-11-09

English and Mandarin were tested through a local, guest-only Evil0ctal 5.1.11 deployment, CPU base ASR and Tesseract chi_sim+eng. Each row is a separate real source or explicit failure input. Counts describe outputs, not transcript accuracy. Do not commit the resulting media, signed links or credentials.

| Case | Input and evidence | Observed result |
|---|---|---|
| Chinese speech, subtitles, technical tutorial | [Creator’s Spring Boot / Vue administration demo](https://www.douyin.com/video/7422312100527148322) | 563.7 s, zh, 32 speech segments, 12 frames, 12 nonempty OCR rows. OCR identifies the framework names. Several technical terms are mistranscribed. |
| English speech | [English vocabulary lesson](https://www.douyin.com/video/7545769396452379939) | 365.444 s, en, 142 speech segments, 10 frames, 9 nonempty OCR rows. The transcript begins with the unit heading and spoken vocabulary. |
| No spoken narration, save enabled | [Creator-offered green-screen footage](https://www.douyin.com/video/7222146097379134758) | 19.526 s, 0 segments, 10 frames and 8 nonempty OCR rows. The platform download file contained 768,272 bytes. |
| Rapid visual changes, Chinese music, save disabled | Tester-supplied public share, repeated in independent CLI and installed Codex sessions | 28.001 s, 4 segments, 12 frames, 12 nonempty OCR rows. The client cited the street at 0 s and the dark underwater scene at 13 s. It identified uncertainty in the sung words and wrote a report. A separate keepPlayback run retained a 1920×1080 H.264/AAC playback copy. Default analysis left no MP4. |
| Unavailable video | Canonical video path with nonexistent ID 9999999999999999999 | Live provider returned NOT_FOUND, CLI exit 1. |
| Photo share at v0.1.0 | Tester-supplied public note | The video-only release identified the note and returned UNSUPPORTED_MEDIA. See current album results below. |
| Invalid input | `media-lens identify file:///tmp/a` | INVALID_URL, exit 2 before any platform request. |

The underlying platform can revoke public access or change rendition delivery. Rerun with an authorized equivalent if a listed sample becomes unavailable. Private and deleted flags are also covered by isolated provider tests.

## Album and Bilibili acceptance after v0.1.0

| Input | Observed evidence |
|---|---|
| Three-page Jiuzhaigou Live Photo album | Installed plugin read three posters and six motion frames. All nine OCR entries had a page. Page 3 showed waterbirds and trailing wakes. |
| Eight-page static Origami note | Eight posters, null timestamps, no motion frames. Both album runs removed the source media. |
| 433-second Mandarin Bilibili tutorial | MCP returned 294 speech segments and 30 frames. A report linked the locked-screen scheduling example to a specific frame. |
| 88-second Bilibili software animation | MCP returned 0 speech segments and 30 frames. A report traced device layout and file dragging using the screen evidence. |
| Public 13-part upload, P2 | Resolve returned part 2 of 13, Coffee Run, 185 seconds. A separate b23.tv test identified a canonical BV URL. |

For each Bilibili sample the installed plugin's launcher returned actual JPEG content and saved a time-cited report. The reports and raw user media are kept out of Git. Offline part-selection, scope, restricted content, incomplete rendition and CDN checks live in `tests/bilibili.test.ts`.

## Unreleased creator-study acceptance · 2026-11-09

A local installation retained its existing version number. Three real-material cases were exercised through a fresh stdio MCP client: an existing three-page scenic Live Photo task produced an analysis alone; a Bilibili author's observed collection yielded six rankable uploads, a newly processed high/ordinary pair and a report with two original directions (target left empty); an existing software demonstration produced a separate 60-second, screen-only production plan. The client read actual frames and available transcripts before writing. The pair had 318,316 and 25,757 likes at observation; this was a six-work collection sample, not an account-wide ranking or an explanation of recommendation behavior. No video file, account credentials or personal brief are needed in this repository. Reproduce selection with `media-lens compare "$PROFILE_URL" --sample-size 6 --pairs 1`, and try the three natural-language examples in the README. [Pair selection tests](../../tests/comparison.test.ts) · [stdio prompt, artifact and citation tests](../../tests/mcp.test.ts).

## Xiaohongshu guest acceptance

A fresh installed MCP server ran `media_analyze` on a user-provided App short link; the task failed with `IDENTITY_LOGIN_REQUIRED` and `media_get_frame` returned `NOT_READY`. No browser or user session was used. The [adapter tests](../../tests/xiaohongshu.test.ts) separately pass synthetic note HTML, a generated MP4 and a two-page album through the local worker. Positive live acceptance is still open: obtain a guest-readable share, read a real frame through MCP and answer a question the preview cannot answer. See [scope and error meanings](../providers/xiaohongshu.md).
