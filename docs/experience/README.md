# Engineering experience

[Passing decoded audio into ASR](patterns/asr-pcm.md) applies when FFmpeg succeeds but transcription fails opening the WAV. Verified with English and Mandarin clips on the same locked stack.

[Separating recognition from visual evidence](patterns/recognition-evidence.md) applies when a missing model hides usable frames, confidence conflicts with the visible image, or change-driven sampling misses the close. Verified with offline model isolation and three video samples; a [paired Mandarin evaluation](../development/2026-11-10_mandarin-asr-comparison.md) compares isolated clips with full-recording time citations on one accented source, not dialect-wide accuracy.

The same [recognition evidence](patterns/recognition-evidence.md) records a moving watermark and high-confidence short noise on archived frames. For repeated generic download failures, see [open diagnostic cases](unresolved.md): status loss was reproduced offline, but the historical cause is unknown.

[Separating API readiness, guest capacity and video access](patterns/provider-readiness.md) applies when health checks pass but real Douyin resolution fails. A live signature refusal was traced to an incomplete guest identity. A complete guest then obtained the same post. Both save-enabled and playback-only delivery were verified. Error transport and capacity boundaries are regression-tested offline.

[Media CDN redirects](patterns/media-cdn-redirect.md) applies when a verified platform download is rejected during transfer. The redirect shape was exercised twice on one live post; separate CDN 403 transfers and tests cover scoped headers, alternatives and a single fresh resolution.

[Album media lives on each page](patterns/album-pages.md) applies when an image album has a post-level video or duration. Verified on a three-page live album and in provider tests.

[Match a Bilibili player to a part](patterns/bilibili-parts.md) applies to shares with a page query and multi-part post durations. Verified with a 13-part public upload and covered with isolated mismatch, preview and segmented-media tests.

[Author feed coverage and missing metrics](patterns/author-feed-coverage.md) applies when a public video is readable but the creator feed stops or omits likes. Verified for Bilibili with an independently published collection directory; Douyin guest upload refusal was observed repeatedly. A reserved login and independent guest detail checks yielded two pages for the same author whose guest feed had been refused. Matched video comparisons were also exercised on an explicitly scoped Bilibili collection. Limited first-page handling is verified against both v5 response shapes in fixtures.

[Xiaohongshu share recognition versus content access](patterns/xhs-share-gates.md) applies when a note ID is known but the next request leads to login or an error page. Verified on live guest refusals; successful media decoding is fixture-tested only.

[Final-image runtime checks](patterns/container-runtimes.md) cover a copied Node binary missing a shared library and the ASR worker interpreter location when the Python base changes. The Node startup failure was observed in CI.
