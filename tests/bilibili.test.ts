import { afterEach, expect, it, vi } from "vitest";
import { normalizeBilibili } from "../packages/core/bilibili.js";
import { configSchema } from "../packages/core/config.js";
import { checked, share } from "../packages/core/network.js";
import { evil, identify, inspectEvil } from "../packages/core/providers.js";

const bvid = "BV1Q34P6vEzR";
const canonical = "https://www.bilibili.com/video/" + bvid + "/";
const second = canonical + "?p=2";
const cdn = "https://upos-sz-mirrorcos.bilivideo.com/file";
const play = { format: "mp4", timelength: 60500, durl: [{ url: cdn }] };
const rights = { no_share: 0, pay: 0, ugc_pay: 0, download: 0 };
const raw = {
  bvid,
  aid: 4567,
  state: 0,
  rights,
  __dtk_part: 2,
  __dtk_streams: play,
};
const data = {
  platform: "bilibili",
  kind: "video",
  content_id: bvid,
  title: "Series",
  author: { nickname: "Author" },
  is_private: false,
  is_deleted: false,
  duration_ms: 120000,
  parts: [
    { part: 1, title: "First part", duration_ms: 60000 },
    { part: 2, title: "Second part", duration_ms: 60000 },
  ],
  raw,
};
const conf = configSchema.parse({});
const ok = (data: unknown) => Response.json({ success: true, data });
afterEach(() => vi.unstubAllEnvs());

it("routes the requested Bilibili part without tracking parameters and returns only public metadata", async () => {
  const input =
    "分享 " + canonical.replace("www.", "m.") + "?vd_source=tracking&p=2#t=4";
  expect(await identify(input)).toMatchObject({
    id: bvid,
    url: second,
    platform: "bilibili",
  });
  vi.stubEnv("EVIL0CTAL_API_KEY", "test-only");
  const req = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(data));
  const found = await evil(conf, req).resolve(input);
  const api = new URL(String(req.mock.calls[0][0]));
  expect(api.pathname).toBe("/api/v1/bilibili/video");
  expect(api.searchParams.get("url")).toBe(second);
  expect(found.stream).toBe(cdn);
  expect(found.media).toMatchObject({
    id: bvid,
    sourceUrl: second,
    duration: 60,
    part: { number: 2, total: 2, title: "Second part" },
    downloadPermission: "disabled",
  });
  expect(JSON.stringify(found.media)).not.toContain(cdn);
  expect(normalizeBilibili(data, second.replace(bvid, "av4567")).media).toEqual(
    found.media,
  );
  expect(share("https://b23.tv/aBc1?p=2&share_source=copy")).toBe(
    "https://b23.tv/aBc1?p=2",
  );
});
it.each(["?p=0", "?p=-1", "?p=2&p=3", "?p=1.5", "?p=10000"])(
  "rejects ambiguous or invalid part %s",
  (q) => {
    expect(() => share(canonical + q)).toThrowError(
      expect.objectContaining({ code: "INVALID_PART" }),
    );
  },
);
it.each([
  canonical.replace("https:", "http:"),
  canonical.replace("www.", "x."),
  canonical.replace(".com", ".com:8080"),
  canonical.replace("video", "bangumi"),
  canonical.replace(bvid, "BV1invalid"),
])("rejects unsupported share %s", (input) => {
  expect(() => share(input)).toThrow();
});
it("rejects mismatched AV, BV, and selected part data", () => {
  for (const input of [
    second.replace(bvid, "av8765"),
    second.replace(bvid, "BV1fZ4G6KEpx"),
    canonical,
    canonical + "?p=3",
  ])
    expect(() => normalizeBilibili(data, input)).toThrow();
  expect(() =>
    normalizeBilibili(
      { ...data, raw: { ...raw, __dtk_part: undefined } },
      second,
    ),
  ).toThrow();
});
it.each([
  { is_private: true },
  { is_deleted: true },
  { raw: { ...raw, state: -4 } },
  { raw: { ...raw, rights: undefined } },
  { raw: { ...raw, rights: { ...rights, pay: 1 } } },
  { raw: { ...raw, rights: { ...rights, no_share: 1 } } },
  { raw: { ...raw, rights: { ...rights, ugc_pay: 1 } } },
  { raw: { ...raw, is_upower_exclusive: true } },
  { raw: { ...raw, __dtk_streams: { ...play, is_preview: 1 } } },
])("rejects restricted or unconfirmed guest content", (patch) => {
  expect(() => normalizeBilibili({ ...data, ...patch }, second)).toThrowError(
    expect.objectContaining({ code: "PUBLIC_VIDEO_UNCONFIRMED" }),
  );
});
it.each([
  undefined,
  { format: "dash" },
  { ...play, durl: [...play.durl, ...play.durl] },
  { ...play, timelength: 30000 },
])(
  "preserves the metadata when a complete progressive part is unavailable",
  (streams) => {
    const found = normalizeBilibili(
      { ...data, raw: { ...raw, __dtk_streams: streams } },
      second,
    );
    expect(found.stream).toBeNull();
    expect(found.media.part?.number).toBe(2);
  },
);
it("allows only platform-supplied Bilibili mirrors, checked independently from Douyin", () => {
  const streams = (url: string, backup_url: string[] = []) => ({
    ...data,
    raw: { ...raw, __dtk_streams: { ...play, durl: [{ url, backup_url }] } },
  });
  const bad = "https://upos-someone-else.akamaized.net/file";
  expect(() => normalizeBilibili(streams(bad), second)).toThrowError(
    expect.objectContaining({ code: "UNSAFE_URL" }),
  );
  expect(
    normalizeBilibili(streams(bad, [cdn.replace("https:", "http:")]), second)
      .stream,
  ).toBe(cdn);
  expect(
    checked("https://upos-hz-mirrorakam.akamaized.net/a", "bili-stream")
      .hostname,
  ).toBe("upos-hz-mirrorakam.akamaized.net");
  expect(() => checked(cdn, "stream")).toThrow();
  expect(() =>
    checked("https://evil.bilivideo.com.example.org/v", "bili-stream"),
  ).toThrow();
  expect(() => checked("https://v.douyinvod.com/v", "bili-stream")).toThrow();
});
it("checks the requested platform's scope and ignores the scalar pool total", async () => {
  vi.stubEnv("EVIL0CTAL_API_KEY", "test-only");
  const req = (scope: string) =>
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(ok({ user: { via: "api_key", scopes: [scope] } }))
      .mockResolvedValueOnce(
        ok({
          pool: { total_active: 10, bilibili: { active: 8 } },
          reserved_active: { bilibili: 2 },
        }),
      );
  expect(await inspectEvil(conf, req("douyin:read"), "bilibili")).toMatchObject(
    { code: "PROVIDER_SCOPE" },
  );
  expect(
    await inspectEvil(conf, req("bilibili:read"), "bilibili"),
  ).toMatchObject({ code: "OK", available: 6 });
});
