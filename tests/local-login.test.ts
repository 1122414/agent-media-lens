import { afterEach, expect, it, vi } from "vitest";
import { LensError } from "../packages/core/contracts.js";
import * as settings from "../packages/core/config.js";
import { listProfile } from "../packages/core/profile.js";
import { queryProviderResult } from "../packages/core/providers.js";
const c = settings.configSchema.parse({});
const uid = "MS4wLjABAAAA0123456789",
  url = "https://www.douyin.com/user/" + uid;
const pin = "00000000-0000-4000-8000-000000000001",
  apiKey = "local-fixture-only";
const identity = {
  id: pin,
  platform: "douyin",
  authenticated: true,
  rotation_endpoints: [],
  expires_at: null,
  state: "active",
  cooldown_until: null,
  session: { verdict: "ok" },
};
const ok = (data: unknown, meta?: unknown) =>
  Response.json({ success: true, data, meta });
const meta = { identity_id: pin, cached: false };
const mockPin = () =>
  vi
    .spyOn(settings, "douyinLogin")
    .mockReturnValue({ apiKey, identityId: pin });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function item(id: string, top = 0) {
  return {
    platform: "douyin",
    content_id: id,
    kind: "video",
    title: "public title",
    author: { uid, nickname: "A" },
    is_private: false,
    is_deleted: false,
    created_at: "2026-11-01T01:00:00Z",
    fetched_at: "2026-11-09T01:00:00Z",
    duration_ms: null,
    stats: { digg_count: 0 },
    raw: {
      aweme_id: id,
      author: { sec_uid: uid, secret: 0 },
      status: {
        private_status: 0,
        is_delete: false,
        is_prohibited: false,
        allow_share: true,
      },
      is_top: top,
      other: "never-return-this",
    },
  };
}
it("pins both upload pages, verifies immediate and polled receipts, and drops unconfirmed or restricted rows", async () => {
  mockPin();
  vi.stubEnv("EVIL0CTAL_API_KEY", "different-guest-key");
  const a = item("123456780", 1),
    b = item("123456781");
  const requests: URL[] = [];
  const request = vi.fn(async (input: URL, opt: RequestInit) => {
    const u = new URL(input);
    requests.push(u);
    expect(u.origin).toBe("http://127.0.0.1:8000");
    expect(new Headers(opt.headers).get("x-api-key")).toBe(apiKey);
    expect(opt.redirect).toBe("error");
    if (u.pathname.endsWith("/identities")) {
      expect(u.searchParams.get("identity_id")).toBe(pin);
      return ok([identity]);
    }
    if (u.pathname.includes("/tasks/"))
      return ok({
        state: "done",
        result_meta: meta,
        data: { items: [b], has_more: false, cursor: null },
      });
    expect(u.pathname).toBe("/api/v1/douyin/user/posts");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      identity: pin,
      include_raw: "true",
      sec_user_id: uid,
      count: "2",
    });
    if (u.searchParams.has("cursor")) {
      expect(u.searchParams.get("cursor")).toBe("50");
      return Response.json(
        {
          success: true,
          data: { task_id: "00000000-0000-4000-8000-000000000003" },
        },
        { status: 202 },
      );
    }
    return ok(
      {
        items: [
          a,
          { ...b, raw: null },
          { ...b, raw: { ...b.raw, author: { sec_uid: uid, secret: 1 } } },
          {
            ...b,
            raw: { ...b.raw, status: { ...b.raw.status, private_status: 1 } },
          },
          { ...b, raw: { ...a.raw } },
        ],
        has_more: true,
        cursor: "50",
      },
      meta,
    );
  });
  vi.stubGlobal("fetch", request);
  const first = await listProfile(c, url, { auth: "local-login", count: 2 });
  expect(first).toMatchObject({
    auth: "local-login",
    view: "posts",
    items: [
      {
        id: a.content_id,
        pinned: true,
        title: a.title,
        url: "https://www.douyin.com/video/" + a.content_id,
        stats: { likes: 0 },
      },
    ],
    nextCursor: "50",
  });
  const second = await listProfile(c, url, {
    auth: "local-login",
    view: "posts",
    cursor: first.nextCursor!,
    count: 2,
  });
  expect(second).toMatchObject({
    items: [{ id: b.content_id, pinned: false }],
    nextCursor: null,
  });
  for (const hidden of [pin, apiKey, "never-return-this"])
    expect(JSON.stringify([first, second])).not.toContain(hidden);
  expect(requests).toHaveLength(5);
});
it.each([
  { ...meta, cached: true },
  { ...meta, guest_fallback: true },
  { identity_id: "different", cached: false },
  {},
])("refuses results that do not prove a fresh pinned request", async (m) => {
  mockPin();
  const request = vi
    .fn()
    .mockResolvedValueOnce(ok([identity]))
    .mockResolvedValueOnce(ok({}, m));
  await expect(
    queryProviderResult(
      c,
      "douyin",
      "user/posts",
      { sec_user_id: uid },
      request,
      "local-login",
    ),
  ).rejects.toMatchObject({ code: "LOCAL_LOGIN_UNCONFIRMED" });
  expect(request).toHaveBeenCalledTimes(2);
});
it.each([
  { ...identity, expires_at: "2000-01-01T00:00:00Z" },
  { ...identity, rotation_endpoints: null },
  { ...identity, authenticated: false },
])(
  "stops before a platform read if the login is expired, shared, or guest",
  async (record) => {
    mockPin();
    const request = vi.fn().mockResolvedValueOnce(ok([record]));
    await expect(
      queryProviderResult(
        c,
        "douyin",
        "user/posts",
        { sec_user_id: uid },
        request,
        "local-login",
      ),
    ).rejects.toMatchObject({ code: "LOCAL_LOGIN_REQUIRED" });
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("never reads a local credential for another origin, collection, or platform", async () => {
  const request = vi.fn();
  await expect(
    queryProviderResult(
      { ...c, endpoint: "https://other.example" },
      "douyin",
      "user/posts",
      { sec_user_id: uid },
      request,
      "local-login",
    ),
  ).rejects.toMatchObject({ code: "LOCAL_LOGIN_ENDPOINT" });
  await expect(
    listProfile(c, url, { auth: "local-login", view: "collections" }, request),
  ).rejects.toMatchObject({ code: "LOCAL_LOGIN_SCOPE" });
  await expect(
    listProfile(
      c,
      "https://space.bilibili.com/1234",
      { auth: "local-login" },
      request,
    ),
  ).rejects.toMatchObject({ code: "LOCAL_LOGIN_SCOPE" });
  expect(request).not.toHaveBeenCalled();
});

it("checks a missing account visibility flag as a guest, keeps an untitled public post, and stops guest reads on refusal", async () => {
  const a = item("100000001"),
    b = item("100000002"),
    d = item("100000003");
  const asList = (p: typeof a) => ({
    ...p,
    title: "",
    raw: { ...p.raw, author: { sec_uid: uid } },
  });
  const q = vi
    .fn()
    .mockResolvedValueOnce({
      data: { items: [a, b, d].map(asList), has_more: false, cursor: null },
      guestFallback: false,
    })
    .mockResolvedValueOnce({
      data: { ...a, title: "", stats: { digg_count: 16 } },
      guestFallback: false,
    })
    .mockRejectedValueOnce(new LensError("UPSTREAM_RISK_CONTROL", "stopped"));
  const r = await listProfile(
    c,
    url,
    { auth: "local-login", details: false },
    q,
  );
  expect(r).toMatchObject({
    items: [{ id: a.content_id, title: "", stats: { likes: 16 } }],
    visibilityError: "UPSTREAM_RISK_CONTROL",
  });
  expect(q.mock.calls.map((call) => [call[2], call[5] ?? "guest"])).toEqual([
    ["user/posts", "local-login"],
    ["video", "guest"],
    ["video", "guest"],
  ]);
});
