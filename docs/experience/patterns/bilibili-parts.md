# Match the player to the requested Bilibili part

On Evil0ctal v5.1.11 the post ID and top-level duration can describe an entire upload. A page query selects one CID and one player response. A resolver that strips the query can return the first part with a plausible title and successful media transfer.

Preserve the requested part across short-link expansion and provider dispatch. Match the BV or av identifier, the one-based part in the list and the player selection under `raw.__dtk_part` (the default is 1). Use the selected part's duration. Only a complete supported player file supplies media evidence. A partial or segmented variant can still supply public metadata.

Verified on one public 13-part upload. Requesting P2 returned Coffee Run, 185 seconds. Two independent single-part uploads completed normal analysis. These observations apply to the pinned upstream contract. [Adapter](../../../packages/core/bilibili.ts) · [part and access regression tests](../../../tests/bilibili.test.ts).
