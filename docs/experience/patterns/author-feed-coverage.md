# Report the scope of creator feeds

A video detail, the owner's uploads and their collection directory are independently served resources. On Evil0ctal 5.1.11, Bilibili returned a first uploads page but refused the next page. The same owner's three public seasons yielded 23 distinct author-matched posts. The list rows omitted likes; public video details supplied all 23. A random draw from this catalog describes the collections. Coverage of every upload is unknown.

On Douyin an author with a readable public video had a rejected uploads feed and zero public collections. After a subsequent refusal the local guest capacity was exhausted. Treat a refused feed as unavailable even if its companion directory is empty. A successful detail response or an empty collection cannot verify upload access. The upstream also documents guest pagination limits for Douyin uploads.

Use `view`, `postListError`, `collectionListError` and the two cursors to record the source and any incomplete pages. Deduplicate by platform ID and check the author of every entry. Keep missing metrics null and distinguish them from an observed zero. Verified on one Bilibili creator and observed Douyin refusal cases. [Profile adapter](../../../packages/core/profile.ts) · [regression tests](../../../tests/profile.test.ts).
