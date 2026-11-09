# Bilibili guest video

Use the same Evil0ctal v5.1.11 deployment as the [Douyin adapter](douyin.md). Configure a Bilibili guest identity and give the client key the `bilibili:read` scope. A client serving both platforms needs both read scopes. Pass the key to the CLI or MCP process through `EVIL0CTAL_API_KEY`.

```sh
media-lens doctor --platform bilibili
media-lens identify "$SHARE_URL"
media-lens resolve "$SHARE_URL"
media-lens analyze "$SHARE_URL"
```

Paste a BV or av video URL, or a b23.tv share. A `?p=N` selection survives canonicalization. The adapter reads the public part list, verifies the selected part against the playback response, and uses its own duration and title. Start a separate task for each part you want to analyze. The default duration ceiling is 600 seconds per part. Set `maxSeconds` in the JSON configuration for longer videos, up to 3600 seconds.

The adapter uses the upstream video endpoint and a guest player response. It checks the public, unpaid status and accepts a single progressive MP4 from an allowed Bilibili CDN. If only DASH, multiple file segments or a materially shorter playback length is returned, resolve exposes the public metadata and analyze reports `MEDIA_WITHHELD`. Explicit previews or restricted content fail the public-content check. No logged-in streams, paid episodes, live rooms or automatic whole-collection downloads are implemented.

The guest playback file is temporary by default. When entitled to keep it, pass `--keep-playback` (MCP `keepPlayback: true`). Retained files use `playbackPath`. A platform cache permission of `allowed` alone does not make this a source download.
