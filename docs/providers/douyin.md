# Douyin v5 provider

Use an operator-controlled Evil0ctal instance serving **guest-only public content**. Install the default upstream services on loopback. Browser, downloader and transcriber profiles are unnecessary for this adapter. Deployment contains Redis and PostgreSQL solely for the external provider.

```sh
sh providers/douyin/bootstrap.sh
docker compose -f providers/douyin/compose.yaml config --quiet
DTK_IMAGE=evil0ctal/douyin_tiktok_download_api DTK_IMAGE_TAG=5.1.11 docker compose -f providers/douyin/compose.yaml up --no-build -d --wait
curl -f http://127.0.0.1:8000/readyz
```

Bootstrap checks out the source revision documented in TECH_STACK.md and writes random secrets in a private, ignored .env on first use. Keep that directory local. Use the loopback upstream console to complete its owner setup. A health response only proves API availability. Supply a permitted guest identity and a key with douyin:read. Keep account cookies, setup tokens and key values out of issue reports, terminals with tracing, and chats. For details see [upstream deployment](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/tree/d44264e96cae55a6df341ed4a0b81b3e2d1fbcaf/docker).

For each canonical video, the adapter calls GET /api/v1/douyin/video, requests include_raw and waits briefly. An accepted response is polled at /api/v1/tasks/{uuid}. It reads only the fields needed for visibility, download permission, author, title and media. Stream bytes travel from an allowlisted CDN over validated HTTPS. Unknown permissions stop the task. A restricted or deleted post must not be retried through another identity.

`media-lens identify "$SHARE_URL"` is the least expensive test. Then resolve the same URL and verify metadata before analyzing. Configure the key in the local process environment. The native provider returns a specific unsupported error where acquisition is unavailable.
