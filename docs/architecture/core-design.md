# Core execution

Lens.start validates the share URL, reserves a task in SQLite and returns a UUID plus a promise. The CLI awaits that promise. A persistent MCP server returns the UUID immediately and serves reads as work advances. If the owner process exits, recovery checks its worker process group before failing the abandoned task. A live group keeps the files protected. Download retries are limited to one for connection reset, temporary DNS failure or connection timeout. Task records include UTC stage boundaries, elapsed milliseconds, retry count, error codes and artifact names.

Acquisition, download and worker invocation are injected at the service boundary. Normal entry points select real implementations. Tests replace only the network boundary to process a reproducible local video. Core imports no MCP or Codex types. Each task owns its directory and fails independently.
