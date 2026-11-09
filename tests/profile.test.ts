import { afterEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, providerKey } from "../packages/core/config.js";
import { LensError } from "../packages/core/contracts.js";
import { identifyProfile, listProfile } from "../packages/core/profile.js";
import { checked } from "../packages/core/network.js";

const config = configSchema.parse({});
const bili = "https://space.bilibili.com/12345";
const douyin = "https://www.douyin.com/user/MS4wLjABAAAA0123456789";
const now = "2026-11-09T06:30:00Z";
const post = {
  platform: "bilibili",
  content_id: "BV1Q34P6vEzR",
  kind: "video",
  title: "Title",
  author: { uid: "12345", nickname: "UP" },
  created_at: now,
  fetched_at: now,
  duration_ms: 4500,
  stats: {
    play_count: 123,
    digg_count: null,
    comment_count: 0,
    share_count: -1,
  },
  is_private: false,
  is_deleted: false,
};
const mix = {
  platform: "bilibili",
  mix_id: "101",
  name: "Season",
  owner_id: "12345",
  item_count: 2,
};
const page = (items: unknown[], cursor: string | null = null) => ({
  data: { items, cursor, has_more: Boolean(cursor) },
  guestFallback: false,
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each([200, 202])(
  "marks a Douyin guest preview as partial over HTTP %i",
  async (status) => {
    vi.stubEnv("EVIL0CTAL_API_KEY", "fixture-key");
    const data = {
      items:
        status === 200
          ? [
              {
                ...post,
                platform: "douyin",
                content_id: "1234567890123456789",
                author: { uid: douyin.split("/").pop(), nickname: "Public" },
                stats: { digg_count: 123 },
              },
            ]
          : [],
      has_more: status === 200,
      cursor: status === 200 ? "100" : null,
    };
    const meta = { guest_fallback: true, internal: "hidden-test-value" };
    const request = vi.fn();
    if (status === 200)
      request.mockResolvedValueOnce(
        Response.json({ success: true, data, meta }),
      );
    else
      request
        .mockResolvedValueOnce(
          Response.json(
            {
              success: true,
              data: { task_id: "00000000-0000-4000-8000-000000000000" },
            },
            { status: 202 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            success: true,
            data: { state: "done", data, result_meta: meta },
          }),
        );
    vi.stubGlobal("fetch", request);
    const r = await listProfile(config, douyin, { view: "posts" });
    expect(r).toMatchObject({
      guestLimited: true,
      view: "posts",
      nextCursor: null,
      postListError: null,
    });
    if (status === 200)
      expect(r.items[0]).toMatchObject({
        title: "Title",
        url: "https://www.douyin.com/video/1234567890123456789",
        stats: { likes: 123 },
      });
    else expect(r.items).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("hidden-test-value");
  },
);
it("canonically identifies user profiles and keeps author and video redirect hosts separated", async () => {
  expect(
    (await identifyProfile("看看 " + bili + "/upload/video/?spm_id_from=abc"))
      .url,
  ).toBe(bili);
  expect((await identifyProfile(douyin)).platform).toBe("douyin");
  for (const u of [
    bili.replace("https", "http"),
    bili.replace(".com", ".com.evil.test"),
    bili.replace("space", "name@space"),
    "https://www.bilibili.com/video/BV1Q34P6vEzR",
    douyin.replace("/user/", "/note/"),
  ])
    await expect(identifyProfile(u)).rejects.toThrow();
  expect(() => checked(bili, "dy-profile")).toThrow();
  expect(() => checked(bili, "bili-stream")).toThrow();
});
it("enriches owner-matched public rows with verified detail metrics without returning provider URLs", async () => {
  const q = vi
    .fn()
    .mockResolvedValueOnce(
      page(
        [
          post,
          post,
          { ...post, is_private: true, content_id: "BV1fZ4G6KEpx" },
          { ...post, author: { uid: "21", nickname: "Wrong" } },
        ],
        "2",
      ),
    )
    .mockResolvedValueOnce({
      data: {
        ...post,
        stats: { digg_count: 0, comment_count: 1 },
        media: { video: { url: "secret" } },
        fetched_at: "2026-11-09T06:32:00Z",
      },
      guestFallback: false,
    });
  const r = await listProfile(config, bili, { view: "posts" }, q);
  expect(q.mock.calls.map((c) => c[2])).toEqual(["user/posts", "video"]);
  expect(r.nextCursor).toBe("2");
  expect(r.guestLimited).toBe(false);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]).toMatchObject({
    duration: 4.5,
    url: "https://www.bilibili.com/video/BV1Q34P6vEzR/",
    stats: { likes: 0, views: 123, comments: 1, shares: null },
    statsError: null,
  });
  expect(JSON.stringify(r)).not.toContain("secret");
});
it("preserves Douyin photo notes and treats a zero like count as present", async () => {
  const q = vi.fn().mockResolvedValue(
    page([
      {
        ...post,
        platform: "douyin",
        content_id: "7705708607345848947",
        kind: "image_album",
        author: { uid: douyin.split("/").pop(), nickname: "Public" },
        stats: { digg_count: 0 },
      },
    ]),
  );
  const r = await listProfile(
    config,
    douyin,
    { view: "posts", cursor: "1729100000000" },
    q,
  );
  expect(r.items[0]).toMatchObject({
    url: "https://www.douyin.com/note/7705708607345848947",
    stats: { likes: 0, views: null },
  });
  expect(q).toHaveBeenCalledTimes(1);
  expect(q.mock.calls[0][3].cursor).toBe("1729100000000");
});
it("labels collection-only results after a refused uploads list and returns usable page cursors", async () => {
  const rows = [post, { ...post, content_id: "BV1fZ4G6KEpx" }];
  const q = vi
    .fn()
    .mockRejectedValueOnce(new LensError("UPSTREAM_RISK_CONTROL", "refused"))
    .mockResolvedValueOnce(
      page([mix, { ...mix, owner_id: "7", mix_id: "9" }], "2"),
    )
    .mockResolvedValueOnce(page(rows))
    .mockResolvedValueOnce(page(rows));
  const r = await listProfile(config, bili, { count: 1, details: false }, q);
  expect(r).toMatchObject({
    view: "collection",
    collectionId: "101",
    postListError: "UPSTREAM_RISK_CONTROL",
    nextCursor: "1",
    collectionCursor: "2",
  });
  expect(r.collections).toHaveLength(1);
  const next = await listProfile(
    config,
    bili,
    {
      view: "collection",
      collectionId: "101",
      count: 1,
      cursor: r.nextCursor!,
      details: false,
    },
    q,
  );
  expect(next.items[0].id).toBe("BV1fZ4G6KEpx");
  expect(next.nextCursor).toBeNull();
});
it("distinguishes rejected uploads from an empty profile and an invalid upstream cursor", async () => {
  const err = new LensError("IDENTITY_LOGIN_REQUIRED", "login");
  const q = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(page([]));
  const r = await listProfile(config, bili, {}, q);
  expect(r.postListError).toBe(err.code);
  expect(r.view).toBe("collections");
  await expect(
    listProfile(
      config,
      bili,
      { view: "posts", cursor: "2" },
      vi.fn().mockResolvedValue(page([], "2")),
    ),
  ).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
});
it("stops enrichment on rate limits and preserves list facts", async () => {
  const q = vi
    .fn()
    .mockResolvedValueOnce(
      page([post, { ...post, content_id: "BV1fZ4G6KEpx" }]),
    )
    .mockRejectedValueOnce(new LensError("RATE_LIMITED", "quota"));
  const r = await listProfile(config, bili, { view: "posts" }, q);
  expect(r.items.map((i) => i.statsError)).toEqual([
    "RATE_LIMITED",
    "NOT_REQUESTED",
  ]);
  expect(
    r.items.every((i) => i.stats.likes === null && i.stats.views === 123),
  ).toBe(true);
  expect(q).toHaveBeenCalledTimes(2);
});
it("restricts the saved desktop key to its loopback origin and a private regular file", () => {
  vi.stubEnv("EVIL0CTAL_API_KEY", undefined);
  const d = mkdtempSync(join(tmpdir(), "lens-key-")),
    f = join(d, "reader");
  try {
    expect(providerKey(config, f)).toBeUndefined();
    writeFileSync(f, "EVIL0CTAL_API_KEY=fixture-key\n", { mode: 0o600 });
    expect(providerKey(config, f)).toBe("fixture-key");
    expect(
      providerKey({ ...config, endpoint: "http://127.0.0.1:8001" }, f),
    ).toBeUndefined();
    expect(
      providerKey({ ...config, endpoint: "https://provider.example" }, f),
    ).toBeUndefined();
    const link = join(d, "link");
    symlinkSync(f, link);
    expect(() => providerKey(config, link)).toThrow();
    chmodSync(f, 0o644);
    expect(() => providerKey(config, f)).toThrow();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

it("omits a stale public list entry when later detail reports deletion or a different author", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce(
      page([post, { ...post, content_id: "BV1fZ4G6KEpx" }]),
    )
    .mockRejectedValueOnce(new LensError("NOT_FOUND", "removed"))
    .mockResolvedValueOnce({
      data: {
        ...post,
        author: { uid: "999", nickname: "Other" },
      },
      guestFallback: false,
    });
  const result = await listProfile(config, bili, { view: "posts" }, query);
  expect(result.items).toEqual([]);
});
