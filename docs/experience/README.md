# Engineering experience

[Passing decoded audio into ASR](patterns/asr-pcm.md) applies when FFmpeg succeeds but transcription fails opening the WAV. Verified with English and Mandarin clips on the same locked stack.

[Separating API readiness, guest capacity and video access](patterns/provider-readiness.md) applies when health checks pass but real Douyin resolution fails. A live signature refusal was traced to an incomplete guest identity. A complete guest then obtained the same post. Both save-enabled and playback-only delivery were verified. Error transport and capacity boundaries are regression-tested offline.

[Media CDN redirects](patterns/media-cdn-redirect.md) applies when a verified platform download is rejected during transfer. The precise redirect shape was exercised twice on one live post and tested against unrelated origins.

[Album media lives on each page](patterns/album-pages.md) applies when an image album has a post-level video or duration. Verified on a three-page live album and in provider tests.

[Match a Bilibili player to a part](patterns/bilibili-parts.md) applies to shares with a page query and multi-part post durations. Verified with a 13-part public upload and covered with isolated mismatch, preview and segmented-media tests.
