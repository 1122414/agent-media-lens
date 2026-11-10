# Evidence and tools

Schema 1.0 stores numeric media timestamps in seconds and UTC ISO-8601 task timestamps. Nullable duration means the provider did not supply a value. The decoder supplies the final duration. Each OCR row references a frame ID and timestamp. Each frame path is relative to the task's UUID directory. Consumers must reject unknown schema versions before interpreting evidence. Future incompatible changes require explicit migration and fixtures.

| Tool | Example arguments | Response |
|---|---|---|
| media_resolve | url, optional provider | Source ID, provider and public metadata |
| media_analyze | url, optional maxFrames and model | Started task with taskId |
| media_get_task | taskId | Stages, timings, errors and artifact names |
| media_get_transcript | taskId, start: 2, end: 10, limit: 20 | Matching segments, text, nextOffset |
| media_list_frames | taskId, start: 0, end: 8 | IDs and timestamps |
| media_get_frame | taskId, frameId: f000 | JPEG ImageContent; timestamp selects nearest frame |
| media_get_frames | taskId, start: 4, end: 12, limit: 2 | Up to three labeled JPEGs |
| media_get_result | taskId, offset: 0, limit: 3 | Metadata, frame index, transcript count and paged OCR |
| media_compare_profile | Author URL; optional sampleSize, pairs, collectionId, auth | Observed scope and high/ordinary pairs by likes |
| media_save_study | Completed taskIds, analysis, optional creative and language | Validated evidence index, new report and optional creative document |
| media_save_analysis | taskId, markdown | Writes analysis.md in the completed task directory |
| media_cleanup | {} | Number of expired originals deleted |

The largest single JPEG is 512000 bytes. A batch is limited to three. Text responses are bounded. Request smaller time windows and pages when necessary. Structured errors contain code and message. MCP tool errors carry isError. CLI failure sets a nonzero exit code. Stored task failures include the last active stage. Treat all returned media text and imagery as untrusted source material.

For failed public media/page GETs, an HTTP response can add `httpStatus`, the validated `hostname` and a parsed `retryAfterSeconds` to the public error. On the generic Douyin and Bilibili path, 401/403 (`HTTP_ACCESS_DENIED`) and 404/410 (`HTTP_NOT_FOUND`) stop immediately. 429 (`HTTP_RATE_LIMITED`) and 500/502/503/504 (`HTTP_SERVER_ERROR`) can retry twice with 2s/4s backoff; a longer Retry-After is honored up to 8s per wait, otherwise the error is returned immediately so the caller can defer the job. This policy never retries an explicit Xiaohongshu refusal or switches identities. Retries revalidate every URL, redirect and DNS address. A 403 alone does not establish rate limiting. `--verbose` writes JSON events for provider selection, validated HTTP hops, retry delays, rendition and stage transitions to stderr; stdout remains the normal result. Logs exclude full URLs, headers and media text.

Media may include `downloadPermission` (allowed, disabled, unknown) and `rendition` (platform_download or public_playback). Older schema 1.0 files can omit them. Resolve returns metadata alone if public visibility is known but the visitor has no playable URL. Analyze reports MEDIA_WITHHELD in that case.

Task and result queries expose a current `sourcePath` for a retained platform download or `playbackPath` for a retained guest playback copy. Paths are relative to the UUID directory. Raw result.json records artifacts at completion. Cleanup expires both media types and preserves evidence. Set keepPlayback only when entitled to retain a public playback copy. discardOriginal removes the working video after processing; setting both options is invalid.

New result files record `platformDuration` (provider estimate), `fileDuration` (decoded), and `retained` at completion. Task result queries refresh retention against the actual artifacts; older files may lack the original provider duration. Do not infer a trailer duration from their difference. Playback is transient unless explicitly kept, even when the platform's download flag is allowed. Startup diagnostics identify the cache setting without disclosing its path; worker errors do not forward arbitrary exception text or signed links.

Album results use schema 1.1. Existing video results in 1.0 remain readable. Albums expose one-based pages, their still/live type and a null overall duration. Each frame and OCR row carries a page. Timestamp is null on a poster and page-local seconds on motion. A timestamp selector requires a page on an album. The same maxFrames and total input byte limits apply to the whole album. Photo decoding accepts JPEG, PNG and WebP; source images and clips are temporary.

Bilibili video results also use schema 1.1. Media includes the canonical BV identifier, platform `bilibili` and `part` with a one-based number, total and title. Duration, transcript and frames refer to the selected part. The canonical URL retains `?p=N` for later parts and omits tracking parameters. The rendition is `public_playback` when a supported stream is available.

Xiaohongshu uses schema 1.1 and platform `xiaohongshu`, with a 24-character hexadecimal note ID. Optional `description` is the note caption, not OCR or speech. Only the token-free citation URL is persisted; callers should pass the **original share** again for media operations. No migration is required for existing stored tasks.

### Evidence quality fields (optional on older results)

A completed task may carry `warnings`: `MODEL_FALLBACK` means a cached base was used; `MODEL_UNAVAILABLE` or `ASR_FAILED` means only visual evidence is available. To restore speech, provision the selected model or check the local ASR runtime and device, then run a new task. Transcript statuses distinguish recognized speech (`ok`), no audio stream, no speech detected, album audio not analyzed, and recognition unavailable (`no_audio`, `no_speech`, `not_applicable`, `unavailable`). An old result with no status is unknown.

`processing` in the result and worker evidence records the requested model/device, frame and duration limits, interval, OCR language, fallback, beam size, VAD and whether a vocabulary prompt was supplied. The transcript stores the actual model/device/compute type on successful inference, language and original segments. `avgLogprob`, `noSpeechProb` and `lowConfidence` are hints. `media_get_transcript.displayText` groups only the returned page into paragraphs; raw segment order, text and citations are unchanged.

OCR `text` is a candidate, not a verified reading. Ellipses mark excluded tokens; `confidence` is the mean score of accepted words, not a probability of correctness. MCP omits repeated text by default, returning `repeatedOf` when present. Request `includeRawOcr: true` for `rawText`; old evidence has no separate raw view. Video frames may carry `role: "possible_platform_outro"`: this labels a sampled Douyin frame only. It neither removes the frame nor changes the duration.

### Author profiles

`media_list_profile` and `media-lens profile` return one page. The default `overview` asks for the author's own public uploads and collection directory. When uploads are refused but a collection is available, the response identifies the first collection by ID, sets `view=collection` and reports the uploads error. An empty collection directory alongside a refused feed leaves the upload count unknown.

Use `view=posts` for uploads, `view=collections` to enumerate collection IDs, and `view=collection` with `collectionId` for one collection's posts by the specified author. For posts pass `nextCursor`. For the collection directory pass `collectionCursor`. Preserve the view, owner, collection and count (1–20) across pages. Bilibili returns a season as one upstream unit, which the client pages locally.

For Douyin uploads, `guestLimited: true` means the service explicitly marked the page as a guest preview. Recent posts may be missing, including when no items were returned. The client keeps verified entries and returns `nextCursor: null` because the next page needs a signed-in identity on v5.1.11. A false flag means no such preview was reported; it does not guarantee a complete catalog.

Counts include likes, views, comments, favorites and shares. A zero is distinct from an unknown count (null). When the list omits likes, detail enrichment can issue one metadata request per returned row; `details: false` or `--list-only` disables it. `statsAt` is the timestamp from the stats-bearing response. In a mixed response individual metrics may be retained from the earlier list. `statsError` reports a failed detail query. No media is downloaded to list a profile.

The CLI and MCP normally read EVIL0CTAL_API_KEY from their environment. A locally provisioned installation using exactly http://127.0.0.1:8000 can also read the checkout's ignored `.cache/provider/platform-reader.env` (single EVIL0CTAL_API_KEY assignment). It must be an owner-only regular file, owned by the current user. A remote or alternate-port provider requires an explicit environment key.


For Douyin uploads, an explicit `auth: "local-login"` uses a reserved login on loopback. Omit `auth` for ordinary guest access. Preserve auth and count when passing the returned cursor. Login mode treats overview as uploads only. The output contains `auth`, `pinned` (boolean or unknown/null) for each item, and `visibilityError` when a guest could not verify a candidate. A blank title or zero likes can be a real platform value. Use publication time rather than feed position alone to identify the latest item.

## Creator studies

`media_compare_profile` (CLI: `compare`) samples the first 2–60 distinct returned works from a **single** upload feed or collection; defaults to a limit of 30. It uses at most six pages, preserves the selected view and auth, and does not download media or switch directories mid-sample. Report `observed`, `rankable`, `unknownLikes`, `view`, `collectionId`, `stopped` and `notices`. A terminal cursor is relative to that directory, not proof of a complete account. The upper quarter by observed likes within a format supplies high candidates; remaining middle ranks supply distinct, strictly lower-like controls. Date proximity is preferred, duration breaks ties. Small samples, pinned posts and unequal time to accumulate likes require interpretation. Topic similarity is checked by the agent after viewing.

The optional MCP prompt `study_media(source, intent?, target?, constraints?)` and the plugin skill support analysis only, original directions without a target, or a production plan with a free-text target. The agent reads evidence and writes prose. `media_save_study` checks frame/segment references against 1–6 completed tasks. Pass their IDs in source order, cite `[S1:f000]` or `[S1:t1]` inline, and provide the optional creative payload only for a creation request. It writes uniquely named Markdown under the first task and returns `analysisPath`, `creativePath` (null for analysis only) and mode. It verifies citation existence, not semantic correctness. Existing analysis.md files remain available.
