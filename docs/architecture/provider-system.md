# Provider selection

The provider interface returns normalized media metadata and an ephemeral candidate stream. The public result excludes the stream and raw platform data. The native resolver expands allowlisted HTTPS shares and identifies video, note or slides before metadata acquisition.

The Evil0ctal provider reads a configured service origin, uses the local key there only, and checks a fresh v5 result. It requires explicit public visibility, then reports the share-menu download setting separately. Public metadata can be returned even without a usable media stream. A guest playback stream supports analysis. For permitted local retention, the result distinguishes the public playback and platform download renditions. Bounded polling handles asynchronous task state. Configured fallback runs only on a service connection error. Authorization or platform refusal never triggers an alternate acquisition path.

[Deployment and permissions](../providers/douyin.md) · [TypeScript contract](../../packages/core/contracts.ts)
