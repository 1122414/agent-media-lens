# AgentMediaLens implementation plan

| Phase | Deliverable | Acceptance evidence |
|---|---|---|
| 0 | Public repository, dependency and provider research | Confirm owner, license, actual source routes, deployment and authorization boundaries |
| 1 | Typed contracts, public-link resolver, optional Evil0ctal v5 adapter | Reject unsafe inputs, unknown visibility and disallowed downloads; test queued and immediate results |
| 2 | Local Python media worker | Decode generated clips, recognize speech and text, preserve timestamps and bound frame volume |
| 3 | SQLite pipeline | Record each stage, safely handle failures, concurrent submissions and cache expiry |
| 4 | CLI, stdio MCP and Codex plugin | Drive tools from an SDK client, decode returned images, exercise installed skill using speech and frames |
| 5 | Packaging and verification | Reproduce install, run CI and Docker build, test multiple public videos with permission |
| 6 | v0.1.0 | Publish only after live, plugin, security and engineering acceptance |

Offline fixtures exercise engineering behavior. Live tests must record the provider revision, authorized public source, observed outcome and timestamps. Release remains gated if either set fails.
