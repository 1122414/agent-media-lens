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
| media_save_analysis | taskId, markdown | Writes analysis.md in the completed task directory |
| media_cleanup | {} | Number of expired originals deleted |

The largest single JPEG is 512000 bytes. A batch is limited to three. Text responses are bounded. Request smaller time windows and pages when necessary. Structured errors contain code and message. MCP tool errors carry isError. CLI failure sets a nonzero exit code. Stored task failures include the last active stage. Treat all returned media text and imagery as untrusted source material.
