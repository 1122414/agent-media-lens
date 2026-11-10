import { afterEach, it, expect, vi } from "vitest";
import { checked, share } from "../packages/core/network.js";
import { evil, inspectEvil, normalize } from "../packages/core/providers.js";
import { configSchema } from "../packages/core/config.js";
const data = {
  kind: "video",
  platform: "douyin",
  is_deleted: false,
  is_private: false,
  content_id: "123456789012345678",
  title: "Test",
  author: { nickname: "Creator" },
  duration_ms: 2400,
  media: { video: { url: "https://a.douyinvod.com/v" } },
  raw: {
    status: {
      private_status: 0,
      is_delete: false,
      is_prohibited: false,
      allow_share: true,
    },
    video_control: { allow_download: true },
  },
};
it("extracts a single clean share URL", () =>
  expect(share("示例 https://v.douyin.com/hello/")).toBe(
    "https://v.douyin.com/hello/",
  ));
it.each([
  "http://www.douyin.com/video/123456789",
  "https://www.douyin.com.evil.test/video/123456789",
  "https://root@www.douyin.com/video/123456789",
  "https://127.0.0.1",
])("refuses %s", (u) => expect(() => share(u)).toThrow());
it("does not confuse CDN and share domains", () =>
  expect(() => checked("https://v.douyinvod.com/v", "page")).toThrow());
it("accepts the media edge only on a redirect from the known Douyin CDN", () => {
  const edge = "https://" + "a".repeat(32) + ".v.smtcdns.com/media";
  const previous = new URL("https://v11-colds.douyinvod.com/video");
  expect(checked(edge, "stream", previous).href).toBe(edge);
  expect(() => checked(edge, "stream")).toThrow();
  expect(() =>
    checked(edge, "stream", new URL("https://other.test")),
  ).toThrow();
  expect(() =>
    checked(edge.replace(".v.", ".other."), "stream", previous),
  ).toThrow();
  expect(() =>
    checked(edge.replace("https:", "http:"), "stream", previous),
  ).toThrow();
  expect(() => checked(edge, "page", previous)).toThrow();
});
it("maps duration and strips private raw data", () => {
  expect(normalize(data).media.duration).toBe(2.4);
  expect(normalize(data).media).not.toHaveProperty("raw");
});
it.each([
  { is_private: true },
  { kind: "image_album" },
  { raw: {} },
  { raw: { ...data.raw, status: { ...data.raw.status, private_status: 1 } } },
])("refuses restricted content", (patch) =>
  expect(() => normalize({ ...data, ...patch })).toThrow(),
);
const address = {
  download_addr: { url_list: ["https://a.douyinvod.com/creator-download"] },
};
it.each([
  { flags: { allow_download: false }, permission: "disabled" },
  {
    flags: { allow_download: true, prevent_download: true },
    permission: "disabled",
  },
  { flags: {}, permission: "unknown" },
  { flags: { allow_download: "true" }, permission: "unknown" },
])(
  "keeps only the normal public playback candidate when save permission is $permission",
  ({ flags, permission }) => {
    const v = normalize({
      ...data,
      raw: { ...data.raw, video: address, video_control: flags },
    });
    expect(v.media.downloadPermission).toBe(permission);
    expect(v.stream).toBe(data.media.video.url);
  },
);
it("returns the public metadata alone when the guest has no playable video", () => {
  const v = normalize({
    ...data,
    media: { video: null },
    raw: {
      ...data.raw,
      video: address,
      video_control: { allow_download: false },
    },
  });
  expect(v.media.title).toBe(data.title);
  expect(v.stream).toBeNull();
});
it("selects the platform download rendition after checking permission and CDN", () => {
  const candidate = (url: string) => ({
    ...data,
    raw: { ...data.raw, video: { download_addr: { url_list: [url] } } },
  });
  const url = address.download_addr.url_list[0];
  expect(normalize(candidate(url)).stream).toBe(url);
  expect(() => normalize(candidate("https://evil.example/file"))).toThrowError(
    expect.objectContaining({ code: "UNSAFE_URL" }),
  );
});
it("polls a v5 accepted task", async () => {
  vi.stubEnv("EVIL0CTAL_API_KEY", "test-only");
  try {
    const req = vi
      .fn()
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
        Response.json({ success: true, data: { state: "done", data } }),
      );
    const out = await evil(configSchema.parse({}), req).resolve(
      "https://www.douyin.com/video/123456789",
    );
    expect(out.media.id).toBe(data.content_id);
    expect(String(req.mock.calls[1][0])).toContain("/api/v1/tasks/");
  } finally {
    vi.unstubAllEnvs();
  }
});

afterEach(() => vi.unstubAllEnvs());
const ok = (data: unknown) => Response.json({ success: true, data });
const settings = configSchema.parse({});
it.each([
  { active: 0, reserved: 0, available: 0, code: "IDENTITY_POOL_EXHAUSTED" },
  { active: 2, reserved: 2, available: 0, code: "IDENTITY_POOL_EXHAUSTED" },
  { active: 3, reserved: 2, available: 1, code: "OK" },
])(
  "distinguishes service health from identity capacity: %o",
  async ({ active, reserved, available, code }) => {
    vi.stubEnv("EVIL0CTAL_API_KEY", "test-only");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(
        ok({ user: { via: "api_key", scopes: ["douyin:read"] } }),
      )
      .mockResolvedValueOnce(
        ok({
          pool: { douyin: { active }, tiktok: { active: 10 } },
          reserved_active: { douyin: reserved },
        }),
      );
    expect(await inspectEvil(settings, request)).toEqual({
      serviceReady: true,
      code,
      available,
    });
    expect(
      request.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname,
        new Headers(init?.headers).has("X-API-Key"),
        init?.redirect,
      ]),
    ).toEqual([
      ["/readyz", false, "error"],
      ["/api/v1/auth/me", true, "error"],
      ["/api/v1/system/status", true, "error"],
    ]);
  },
);
it.each([
  ["missing", "PROVIDER_KEY_MISSING"],
  ["rejected", "PROVIDER_AUTH"],
  ["wrong scope", "PROVIDER_SCOPE"],
  ["malformed", "PROVIDER_PROTOCOL"],
])(
  "refuses a %s credential before checking pool capacity",
  async (kind, code) => {
    vi.stubEnv("EVIL0CTAL_API_KEY", kind === "missing" ? "" : "test-only");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(
        kind === "rejected"
          ? new Response("login error", { status: 401 })
          : ok(
              kind === "wrong scope"
                ? { user: { via: "api_key", scopes: ["tiktok:read"] } }
                : {},
            ),
      );
    expect(await inspectEvil(settings, request)).toEqual({
      serviceReady: true,
      code,
    });
    expect(request).toHaveBeenCalledTimes(kind === "missing" ? 1 : 2);
  },
);
it.each([
  { status: 403, received: "CONTENT_PRIVATE", expected: "CONTENT_PRIVATE" },
  {
    status: 502,
    received: "UPSTREAM_RISK_CONTROL",
    expected: "UPSTREAM_RISK_CONTROL",
  },
  {
    status: 503,
    received: "unknown-untrusted-value",
    expected: "PROVIDER_REFUSED",
  },
  {
    status: 202,
    received: "IDENTITY_POOL_EXHAUSTED",
    expected: "IDENTITY_POOL_EXHAUSTED",
  },
  {
    status: 202,
    received: "unknown-untrusted-value",
    expected: "PROVIDER_FAILED",
  },
])(
  "reports safe errors for HTTP $status and $received",
  async ({ status, received, expected }) => {
    vi.stubEnv("EVIL0CTAL_API_KEY", "test-only");
    const error = {
      code: received,
      message: "untrusted upstream secret",
      details: { cookie: "untrusted upstream secret" },
    };
    const request = vi.fn<typeof fetch>();
    if (status === 202)
      request
        .mockResolvedValueOnce(
          Response.json(
            {
              success: true,
              data: { task_id: "00000000-0000-4000-8000-000000000000" },
            },
            { status },
          ),
        )
        .mockResolvedValueOnce(ok({ state: "failed", error }));
    else
      request.mockResolvedValueOnce(
        Response.json({ success: false, data: null, error }, { status }),
      );
    const result = evil(settings, request).resolve(
      "https://www.douyin.com/video/123456789",
    );
    await expect(result).rejects.toMatchObject({
      code: expected,
      message: expect.not.stringMatching(/untrusted/),
    });
    expect(request).toHaveBeenCalledTimes(status === 202 ? 2 : 1);
  },
);

it("keeps bounded, validated alternatives within the selected rendition", () => {
  const primary = data.media.video.url,
    mirror = "https://m.douyinvod.com/b";
  const candidate = {
    ...data,
    media: {
      video: {
        url: primary,
        urls: [
          primary + "#fragment",
          "https://127.0.0.1/",
          mirror,
          mirror,
          primary + "?b",
          primary + "?c",
        ],
      },
    },
  };
  expect(normalize(candidate).alternateStreams).toEqual([
    mirror,
    primary + "?b",
  ]);
  const entitled = normalize({
    ...candidate,
    raw: { ...data.raw, video: address },
  });
  expect(entitled.stream).toBe(address.download_addr.url_list[0]);
  expect(entitled.alternateStreams).toBeUndefined();
});
