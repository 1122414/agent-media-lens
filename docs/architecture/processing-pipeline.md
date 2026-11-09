# From media bytes to evidence

1. The downloader enforces a CDN host allowlist, resolves IPv4 addresses, rejects special-purpose ranges, pins the chosen address for the TLS connection and validates redirect targets. It caps declared and streamed size.
2. ffprobe checks a local MOV/MP4 input, video stream, dimensions and finite duration. FFmpeg extracts mono 16 kHz PCM. Missing audio yields an empty transcript.
3. faster-whisper processes normalized PCM. Speech segments use media seconds. The temporary WAV is removed when transcription ends.
4. One-second grayscale samples provide overall structure. The worker ranks changes across the frame and in its lower quarter, reserves a share of the budget for coverage, then extracts bounded JPEGs. Rapid subsecond cuts and very small text can be missed.
5. Tesseract reads each selected frame. Each OCR result points to its frame ID and media timestamp. MCP transmits JPEG bytes on demand and bounds batch size.

[Worker implementation](../../workers/media_worker.py) · [Result contract](data-contracts.md)
