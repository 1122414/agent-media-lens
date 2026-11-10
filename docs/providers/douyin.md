# Douyin v5 provider

Use an operator-controlled Evil0ctal instance serving **public content with guests by default**. Install the default upstream services on loopback. AgentMediaLens transfers and transcribes media locally. The upstream browser profile is optional when a guest identity already contains the platform-issued visitor ID required for native signing of Douyin post details. Deployment contains Redis and PostgreSQL solely for the external provider.

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

For a resolved public video, requests to the Douyin video CDN carry the fixed public site Referer; redirects to other hosts do not inherit it. A CDN 403 can try up to two validated alternatives of the **same rendition**. If those also return CDN 403, refresh the canonical post once, recheck identity of the work, visibility, rendition, save permission and duration, and try at most one new address. No signed URL is exposed, no 401 or work-level refusal triggers this path, and a failed playback request never switches to an original download.

`media-lens identify "$SHARE_URL"` is the least expensive test. Then resolve the same URL and verify metadata before analyzing. Configure the key in the local process environment. The native provider returns a specific unsupported error where acquisition is unavailable.

With the Evil0ctal provider selected, `media-lens doctor` checks three things in order: service readiness, the API key's Douyin permission, and non-reserved active Douyin identities. The status API provides counts, not the type of each identity: keep all rotating identities guest-only. An OK result is a snapshot, not proof that a platform request will succeed.

| Result | What to do |
|---|---|
| `PROVIDER_KEY_MISSING`, `PROVIDER_AUTH`, `PROVIDER_SCOPE` | Supply a valid local key with `douyin:read` to the CLI or MCP process. |
| `IDENTITY_POOL_EXHAUSTED` | Check the guest pool on the local instance; a healthy API can have no available identities. |
| `UPSTREAM_RISK_CONTROL`, `IDENTITY_LOGIN_REQUIRED` | Stop. Do not switch identities or collection methods to work around a refusal. |
| `PUBLIC_DOWNLOAD_UNCONFIRMED`, `CONTENT_PRIVATE`, `MEDIA_WITHHELD` | Verify explicit public status. Resolve can return metadata when the guest has no usable media address; analysis then reports MEDIA_WITHHELD. |

The same recognized refusal is reported whether the v5 API answers immediately or queues a task. The upstream message, details, raw response and signed media URLs are never copied into that error.

For photo notes and slides, the same detail endpoint returns an image_album. Validate the public status and each ordered page. Download the poster using the Douyin signed-photo CDN policy and any page-level live clip through the existing video CDN policy. The post-level video may be background music. JPEG, PNG and WebP posters are decoded as still images, and the raw pages are deleted after processing.

## Optional local login for public uploads

On a single-user deployment bound to `http://127.0.0.1:8000`, create a separate key in the provider console with precisely `douyin:read` and `identity:manage`, as an operator or admin. Upstream requires the latter to pin an identity; it can also manage credentials, so never give it to a remote caller or set it as the ordinary reader key. Keep the normal pool guest-only. In a local terminal run `media-lens douyin-login` and supply the key when prompted. On macOS `--clipboard` reads the copied Cookie header once after you press Enter; the other option uses hidden terminal input. Sign in at Douyin yourself and use only that site's Cookie and matching User-Agent. The helper rejects redirects and sends the import only to loopback. Never provide these values to an agent.

The helper imports a **reserved** identity and writes only the dedicated key, identity ID and reported expiry into an owner-only ignored file. Each explicit `--local-login` / `auth: "local-login"` request checks reservation, session quality and expiry locally, pins only `douyin/user/posts`, and requires the same identity in the upstream receipt with caching off. It never turns a guest call into a login call after a refusal. Missing account visibility in a signed-in list requires independent public guest detail verification, including with `--list-only`. Unconfirmed or restricted works are omitted; a verification service failure is reported as `visibilityError`. All downloads, details and other profile views retain their ordinary guest credentials.

Re-run the helper if your login expires. To revoke it, retire the reserved identity named **AgentMediaLens: local profile login** and revoke the dedicated API key in the local console; remove `.cache/provider/douyin-login.json`. When replacing a login, retire the previous reserved identity too. There is no need to sign out or change the normal guest pool.
