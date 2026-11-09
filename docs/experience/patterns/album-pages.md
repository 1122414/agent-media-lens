# Find live media on each slide

Douyin can return a post-level video field for an album. Actual motion assets are under media.images[i].video; each page also has its own poster. Inspect the normalized kind and explicit public flags first. Use null timestamps for posters and local seconds for motion. Never infer a continuous video clock from page order or background music.

Verified on one three-page live album. [Adapter](../../../packages/core/providers.ts) · [contract tests](../../../tests/provider.test.ts).
