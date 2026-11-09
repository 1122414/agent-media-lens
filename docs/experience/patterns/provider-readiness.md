# A healthy API can still refuse video acquisition

On Evil0ctal v5.1.11, an empty Douyin identity pool passed /readyz even though a real task failed. After a normal guest identity became available, a public 28-second video played in an unsigned-in browser while the API reported UPSTREAM_RISK_CONTROL. Neither observation established permission to download.

Check /readyz, the API key's scopes at /api/v1/auth/me, then pool.douyin.active minus reserved_active.douyin at /api/v1/system/status. An identity count says nothing about a specific work or whether the operator used only guests. On actual resolution inspect the stable error code in the HTTP error envelope or the terminal task's error. Do not copy upstream messages or try another identity after a refusal.

Verified once against an operator-controlled guest-only v5.1.11 instance. Other providers may expose different signals. [Adapter](../../../packages/core/providers.ts) · [offline boundary tests](../../../tests/provider.test.ts) · [operator guide](../../providers/douyin.md).

On the same deployment, the isolated Core container saw its own loopback and reported the API unreachable. Sharing the API container's network with [the local Compose override](../../../compose.local-provider.yaml) changed the result to “service ready, no available identities”; the host confirmed one cooling identity. This verified connectivity and authentication from a second runtime, not video access. Look up the API container ID again after it is replaced.

For the recorded 28-second video, correlating the existing task with its request log showed `douyin.content_detail`, native signer, HTTP 403 and `signature.refused`. The import audit (cookie names only) showed no visitor ID accepted by the native signer. There were zero archived records for the work. The deployment had passed the import preview and capacity checks with an incomplete guest identity. Check session quality and the request classifier before attributing a refusal to the creator. A successful download after correcting the configuration has yet to be observed.
