# Find live media on each slide

Douyin can return a post-level video field for an album. Actual motion assets are under media.images[i].video; each page also has its own poster. Inspect the normalized kind and explicit public flags first. Use null timestamps for posters and local seconds for motion. Never infer a continuous video clock from page order or background music.

Verified on one three-page live album. [Adapter](../../../packages/core/providers.ts) · [contract tests](../../../tests/provider.test.ts).

A successful nearest-frame lookup alone does not prove the requested time exists. On a stored 33.643991-second video, a request at 99999s previously returned the last JPEG without a label; a video page selector produced an empty batch but a single-frame error. Replaying the same evidence through stdio after the fix rejected both invalid selectors, while a request at the exact end returned f029 at 33s. Verify the actual sample label and use decoded video time, not platform duration. Album posters have no clock; on motion pages with no stored clip duration, the last sample bounds lookup without claiming it is the clip's end. Verified on that archive and with the [mixed-album](../../../tests/album.test.ts) and [MCP](../../../tests/mcp.test.ts) fixtures.
