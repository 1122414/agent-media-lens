# Architecture overview

CLI and stdio MCP clients use the same TypeScript service. A video share passes through platform identification and public metadata resolution before a bounded HTTPS transfer. The Python worker consumes the local file and writes timestamped speech, JPEG and OCR evidence. The client selects frames and writes its interpretation beside the structured result.

| Boundary | Implementation | Responsibilities |
|---|---|---|
| Agent integration | apps/mcp-server, plugins/codex | Manage tool calls, limit responses and return JPEG image content |
| Operator interface | apps/cli | Resolve, analyze, diagnose and inspect cached tasks |
| Core | packages/core | Normalize provider responses, validate network and filesystem access, coordinate the worker and persist task stages in SQLite |
| Media worker | workers | Decode audiovisual data, select frames and extract evidence |
| Optional deployment | providers/douyin | Bootstrap the pinned external API and its own datastore on loopback |

[Component diagram](../../ARCHITECTURE.md) · [Execution and recovery](core-design.md) · [Providers](provider-system.md) · [Media pipeline](processing-pipeline.md) · [Evidence and tools](data-contracts.md)
