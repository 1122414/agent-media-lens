# From media bytes to evidence

1. The downloader enforces a CDN host allowlist, resolves IPv4 addresses, rejects special-purpose ranges, pins the chosen address for the TLS connection and validates redirect targets. It caps declared and streamed size.
2. ffprobe checks a local MOV/MP4 input, video stream, dimensions and finite duration. FFmpeg extracts mono 16 kHz PCM. No audio stream yields transcript status `no_audio`.
3. faster-whisper processes normalized PCM. Speech segments keep the recognized wording, model confidence signals and bounded media seconds. The worker checks the requested snapshot locally, attempts normal model acquisition, then optionally tries an already cached base. It never downloads a different model as a fallback. Missing weights produce a visual-only result with a warning. The temporary WAV is removed when transcription ends.
4. One-second grayscale samples provide overall structure. The worker ranks changes across the frame and in its lower quarter, reserves the first and last available sample when the budget permits, sets anchors on the time axis, then extracts bounded JPEGs. Rapid subsecond cuts and very small text can be missed.
5. Tesseract reads each selected frame. Each OCR result points to its frame ID and media timestamp. The default text filters low-confidence tokens and marks gaps; exact repeats reference the first matching frame on the same page. Confidence does not verify the wording. MCP transmits JPEG bytes on demand and bounds batch size.

[Worker implementation](../../workers/media_worker.py) · [Result contract](data-contracts.md)
