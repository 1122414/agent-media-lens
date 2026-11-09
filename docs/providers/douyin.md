# Douyin v5 provider

Use an operator-controlled Evil0ctal instance serving **guest-only public content**. Install the default upstream services on loopback. AgentMediaLens transfers and transcribes media locally. The upstream browser profile is optional when a guest identity already contains the platform-issued visitor ID required for native signing of Douyin post details. Deployment contains Redis and PostgreSQL solely for the external provider.

```sh
sh providers/douyin/bootstrap.sh
docker compose -f providers/douyin/compose.yaml config --quiet
DTK_IMAGE=evil0ctal/douyin_tiktok_download_api DTK_IMAGE_TAG=5.1.11 docker compose -f providers/douyin/compose.yaml up --no-build -d --wait
curl -f http://127.0.0.1:8000/readyz
```

Bootstrap checks out the source revision documented in TECH_STACK.md and writes random secrets in a private, ignored .env on first use. Keep that directory local. Use the loopback upstream console to complete its owner setup. A health response only proves API availability. Supply a permitted guest identity and a key with douyin:read. Keep account cookies, setup tokens and key values out of issue reports, terminals with tracing, and chats. For details see [upstream deployment](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/tree/d44264e96cae55a6df341ed4a0b81b3e2d1fbcaf/docker).

Evil0ctal also has its own download API, `POST /api/v1/downloads`. For a new post it fetches the details through the same scheduler and identity pool, then saves media to its volume. AgentMediaLens instead reads the details and transfers the validated media URL to the local task directory.

On v5.1.11, the import preview's `usable` flag checks minimum import requirements. Before testing a new deployment, use the local console's identity view to check the guest's **session quality**. A manually imported guest can be active while missing the visitor ID needed by the native signer. If a details request fails with `UPSTREAM_RISK_CONTROL`, inspect its existing request log. HTTP 403 with rule `signature.refused` identifies a signing failure before the adapter can check the work's download permission. The upstream [guest identity guide](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/d44264e96cae55a6df341ed4a0b81b3e2d1fbcaf/documents/en/06-identities-and-proxies.md) describes session quality and the platform-issued visitor ID.

For each canonical video, the adapter calls GET /api/v1/douyin/video, requests include_raw and waits briefly. An accepted response is polled at /api/v1/tasks/{uuid}. It reads only the fields needed for visibility, download permission, author, title and media. Stream bytes travel from an allowlisted CDN over validated HTTPS. A public post with a disabled or unknown save setting uses the ordinary visitor playback URL. For a file the user has rights to keep, request keepPlayback. The official download address is selected only when the save setting permits it. A restricted or deleted post must not be retried through another identity.

`media-lens identify "$SHARE_URL"` is the least expensive test. Then resolve the same URL and verify metadata before analyzing. Configure the key in the local process environment. The native provider returns a specific unsupported error where acquisition is unavailable.

With the Evil0ctal provider selected, `media-lens doctor` checks three things in order: service readiness, the API key's Douyin permission, and non-reserved active Douyin identities. The status API provides counts, not the type of each identity: the operator must keep the instance guest-only. An OK result is a snapshot, not proof that a platform request will succeed.

| Result | What to do |
|---|---|
| `PROVIDER_KEY_MISSING`, `PROVIDER_AUTH`, `PROVIDER_SCOPE` | Supply a valid local key with `douyin:read` to the CLI or MCP process. |
| `IDENTITY_POOL_EXHAUSTED` | Check the guest pool on the local instance; a healthy API can have no available identities. |
| `UPSTREAM_RISK_CONTROL`, `IDENTITY_LOGIN_REQUIRED` | Stop. Do not switch identities or collection methods to work around a refusal. |
| `PUBLIC_DOWNLOAD_UNCONFIRMED`, `CONTENT_PRIVATE`, `MEDIA_WITHHELD` | Verify explicit public status. Resolve can return metadata when the guest has no usable media address; analysis then reports MEDIA_WITHHELD. |

The same recognized refusal is reported whether the v5 API answers immediately or queues a task. The upstream message, details, raw response and signed media URLs are never copied into that error.
