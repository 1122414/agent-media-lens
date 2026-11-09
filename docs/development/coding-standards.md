# Coding standards

Enable strict TypeScript and annotate Python entry points. Validate request and response shapes at the boundary. Map public failures to a stable code and a short actionable message. Stdio transport owns stdout; diagnostic events go to stderr. Never include signed URLs, raw provider payloads, cookies or API keys in logs.

Keep protocol registration in apps, provider HTTP details in its adapter, and media decoding in the Python worker. Project commits use conventional scopes. A change to a persisted contract or a supported client must include a boundary test and a migration decision.
