# Core execution

Lens.start validates the share URL, reserves a task in SQLite and returns a UUID plus a promise. The CLI awaits that promise. A persistent MCP server returns the UUID immediately and serves reads as work advances. If the owner process has exited, the next store opening marks its abandoned work failed. Task records include UTC stage boundaries, elapsed milliseconds, retry count, error codes and artifact names.

Acquisition, download and worker invocation are injected at the service boundary. Normal entry points select real implementations. Tests replace only the network boundary to process a reproducible local video. Core imports no MCP or Codex types. Each task owns its directory and fails independently.
