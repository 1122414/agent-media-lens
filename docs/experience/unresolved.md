# Open diagnostic cases

## Intermittent Douyin media transfer refusals at `7977f4a`

- **Observed:** Five jobs started between 19:02:55 and 19:03:22 on 2026-11-09 (Asia/Shanghai) reached DOWNLOADING and failed with UNAVAILABLE, retries=0. A separate transcription failure was interleaved. A later job succeeded and a subsequent download failed again. No HTTP status, redirect host or Retry-After was persisted. These records do not establish that every job requested the same media.
- **Reproduced offline:** With the real downloader and a controlled HTTPS response, 403, 404, 429 and 503 all made one request and yielded the same public error even with Retry-After. This applies to the generic Douyin transfer path, not every provider or platform. See [response handling](../../packages/core/network.ts) and [transfer retry selection](../../packages/core/service.ts).
- **Verified change:** [Offline HTTP and CLI regression tests](../../tests/public-http.test.ts) now distinguish refusals and transient statuses, test bounded waits and cancellation, and check that signed paths and query values do not reach the log. No live refusal was provoked.
- **Unresolved:** Throttling is one possible explanation, not a verified cause. On the next naturally occurring failure capture only the stage, validated hostname, HTTP status and bounded retry delay. Do not reproduce it by hammering the platform or logging a signed URL. Verify the status before choosing a retry policy.
