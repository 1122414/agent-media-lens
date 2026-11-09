import { expect, it, vi } from "vitest";
import { matchPosts, compareProfile } from "../packages/core/comparison.js";
import { listProfile } from "../packages/core/profile.js";
import { configSchema } from "../packages/core/config.js";
import { LensError } from "../packages/core/contracts.js";

type Page = Awaited<ReturnType<typeof listProfile>>;
const at = "2026-11-09T00:00:00Z",
  config = configSchema.parse({});
function work(
  id: string,
  likes: number | null,
  kind = "video",
  date = "2026-11-08T12:00:00Z",
): Page["items"][number] {
  return {
    id,
    kind,
    title: id,
    url: "https://example.test/" + id,
    author: "A",
    publishedAt: date,
    duration: 25,
    pinned: false,
    statsAt: at,
    statsError: null,
    stats: {
      likes,
      views: null,
      comments: null,
      shares: null,
      favorites: null,
    },
  };
}
function page(items: Page["items"], extra: Partial<Page> = {}): Page {
  return {
    profile: {
      id: "123",
      platform: "bilibili",
      url: "https://space.bilibili.com/123",
    },
    view: "posts",
    collectionId: null,
    auth: "guest",
    nextCursor: null,
    guestLimited: false,
    postListError: null,
    collectionListError: null,
    visibilityError: null,
    collectionCursor: null,
    collections: [],
    observedAt: at,
    items,
    ...extra,
  };
}
it("compares within form, keeps zero and unknown separate, ages new posts and avoids reused controls", () => {
  const rows = [
    work("a", 100),
    work("b", 70),
    work("c", 20),
    work("d", 15),
    work("e", 10),
    work("f", 0),
    work("g", null),
    work("p", 300, "image_album"),
    work("q", 0, "image_album", "2026-08-01T00:00:00Z"),
  ];
  const r = matchPosts(rows, 3, at);
  expect(r.rankable).toBe(8);
  expect(r.unknownLikes).toBe(1);
  expect(r.pairs).toHaveLength(3);
  expect(r.pairs[0]).toMatchObject({
    high: { id: "p", under48Hours: true },
    ordinary: { id: "q", likes: 0, under48Hours: false },
  });
  expect(new Set(r.pairs.flatMap((p) => [p.high.id, p.ordinary.id])).size).toBe(
    6,
  );
  expect(
    matchPosts(
      [work("x", 1), work("y", 1), work("z", 10, "image_album")],
      3,
      at,
    ).pairs,
  ).toEqual([]);
});
it("keeps the same collection and sample scope across pages, deduplicates, and records a later refusal", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(
      page([work("a", 99)], {
        view: "collection",
        collectionId: "100",
        postListError: "UPSTREAM_RISK_CONTROL",
        nextCursor: "1",
      }),
    )
    .mockResolvedValueOnce(
      page([work("a", 99), work("b", 0)], {
        view: "collection",
        collectionId: "100",
        nextCursor: "2",
      }),
    )
    .mockRejectedValueOnce(new LensError("RATE_LIMITED", "limit"));
  const out = await compareProfile(
    config,
    "share",
    { sampleSize: 8, pairs: 1 },
    read,
  );
  expect(read.mock.calls[1][2]).toMatchObject({
    view: "collection",
    collectionId: "100",
    cursor: "1",
    count: 8,
    auth: "guest",
  });
  expect(out).toMatchObject({
    view: "collection",
    collectionId: "100",
    observed: 2,
    rankable: 2,
    pages: 2,
    stopped: "page_error",
    notices: ["UPSTREAM_RISK_CONTROL", "RATE_LIMITED"],
  });
  expect(out.pairs[0].ordinary.id).toBe("b");
});
it("never fills a guest preview with unrelated posts and respects the requested sample size", async () => {
  const preview = vi
    .fn()
    .mockResolvedValue(
      page([work("a", 3)], { guestLimited: true, nextCursor: "2" }),
    );
  expect(await compareProfile(config, "share", {}, preview)).toMatchObject({
    observed: 1,
    stopped: "guest_preview",
    pairs: [],
  });
  expect(preview).toHaveBeenCalledTimes(1);
  const full = vi
    .fn()
    .mockResolvedValue(page([work("a", 3), work("b", 0), work("c", 99)]));
  const r = await compareProfile(config, "share", { sampleSize: 2 }, full);
  expect(r).toMatchObject({ observed: 2, stopped: "sample_limit" });
  expect(r.pairs[0].high.id).toBe("a");
});
