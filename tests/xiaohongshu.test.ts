import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi, beforeEach } from "vitest";
import { checked, share } from "../packages/core/network.js";
import { parseXhsPage } from "../packages/core/xiaohongshu.js";
import { identify, resolveMedia } from "../packages/core/providers.js";
import { configSchema } from "../packages/core/config.js";
import { Lens } from "../packages/core/service.js";
import { worker } from "../packages/core/processing.js";

const { get, lookup } = vi.hoisted(() => ({ get: vi.fn(), lookup: vi.fn() }));
vi.mock("node:https", () => ({ get }));
vi.mock("node:dns/promises", () => ({ lookup }));
const id = "0123456789abcdef01234567",
  other = "1123456789abcdef01234567",
  canonical = "https://www.xiaohongshu.com/explore/" + id,
  signed = canonical + "?xsec_token=fixture&xsec_source=share",
  short = "https://xhslink.cn/o/abc123";
const img = "http://sns-webpic-qc.xhscdn.com/picture!web?test=1";
const video = "http://sns-video-bd.xhscdn.com/video.mp4?test=1";
const note = {
  noteId: id,
  title: "undefined is text",
  desc: 'quoted "text" < 3',
  user: { nickname: "Creator" },
  type: "normal",
  imageList: [{ urlDefault: img }, { url: img }],
};
const html = (state: unknown) =>
  "<script>window.__INITIAL_STATE__=" + JSON.stringify(state) + ";</script>";
const desktop = (n: unknown) =>
  html({ note: { firstNoteId: id, noteDetailMap: { [id]: { note: n } } } });
const mobile = (n: unknown) => html({ noteData: { data: { noteData: n } } });
const film = {
  ...note,
  type: "video",
  video: {
    media: {
      stream: { h264: [{ masterUrl: video, format: "mp4", duration: 2000 }] },
    },
  },
};
const config = configSchema.parse({});
function page(statusCode: number, headers: Record<string, string>, body = "") {
  get.mockImplementationOnce(
    (_url, _opts, cb: (r: IncomingMessage) => void) => {
      cb(
        Object.assign(Readable.from([Buffer.from(body)]), {
          headers,
          statusCode,
        }) as IncomingMessage,
      );
      return new EventEmitter();
    },
  );
}
beforeEach(() => {
  get.mockReset();
  lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
it("keeps App share parameters only on the official HTTPS request and never calls an identity service", async () => {
  expect(share("某分享 http://xhslink.cn/o/abc123 打开小红书")).toBe(short);
  expect(share("https://xhslink.com/a/abc123")).toContain("xhslink.com");
  expect(await identify(signed)).toEqual({
    id,
    platform: "xiaohongshu",
    kind: "note",
    url: canonical,
  });
  page(302, { location: signed.replace("https:", "http:") });
  page(200, { "content-type": "text/html; charset=utf-8" }, desktop(film));
  const result = await resolveMedia(config, short);
  expect(result.provider).toBe("native");
  expect(get.mock.calls.map((c) => c[0].href)).toEqual([short, signed]);
  for (const [, opts] of get.mock.calls)
    expect(Object.keys(opts.headers)).toEqual(["user-agent"]);
  expect(result.media).toMatchObject({
    id,
    sourceUrl: canonical,
    duration: 2,
    rendition: "public_playback",
    author: "Creator",
  });
  expect(result.stream).toBe(video.replace("http:", "https:"));
  expect(JSON.stringify(result.media)).not.toMatch(/fixture|xhscdn/);
});
it("reads the matched mobile album in order and leaves captions separate from image evidence", () => {
  const result = parseXhsPage(
    mobile(note).replace(
      '"noteData":{',
      '"extra":undefined,"set":new Set([]),"noteData":{',
    ),
    id,
  );
  expect(result.slides?.map((s) => s.poster)).toEqual(
    Array(2).fill(img.replace("http:", "https:")),
  );
  expect(result.media).toMatchObject({
    kind: "image_album",
    title: note.title,
    description: note.desc,
    pages: [
      { page: 1, kind: "still" },
      { page: 2, kind: "still" },
    ],
  });
  expect(parseXhsPage(desktop({ ...film, video: null }), id).stream).toBeNull();
  expect(
    parseXhsPage(mobile({ ...note, imageList: [{ url: img }, {}] }), id).slides,
  ).toBeUndefined();
});
it.each([
  desktop({ ...note, noteId: other }),
  desktop({ ...note, isPrivate: true }),
  mobile({ ...note, isDeleted: true }),
  mobile({ ...note, needLogin: true }),
  html({ note: { firstNoteId: other, noteDetailMap: { [id]: { note } } } }),
  '<meta property="og:image" content="poster.jpg"><title>preview</title>',
  "<script>window.__INITIAL_STATE__=process.exit(19)</script>",
  desktop({ ...note, imageList: [{ url: img, livePhoto: true }] }),
])(
  "never treats restricted, other-note, unsupported or preview-only data as visual evidence (%#)",
  (s) => {
    expect(() => parseXhsPage(s, id)).toThrow();
  },
);
it.each([
  ["/login?redirectPath=private", "IDENTITY_LOGIN_REQUIRED"],
  ["/website-security/verify", "UPSTREAM_RISK_CONTROL"],
  ["/404/sec_abc?error_code=300031", "XHS_SHARE_UNAVAILABLE"],
  ["https://www.xiaohongshu.com.example/login", "UNSAFE_URL"],
  ["/explore/" + other, "PROVIDER_PROTOCOL"],
])(
  "stops at a redirect to %s before requesting its target",
  async (location, code) => {
    page(302, { location });
    await expect(resolveMedia(config, signed)).rejects.toMatchObject({ code });
    expect(get).toHaveBeenCalledTimes(1);
  },
);
it.each([
  [403, "UPSTREAM_RISK_CONTROL"],
  [429, "RATE_LIMITED"],
  [404, "XHS_SHARE_UNAVAILABLE"],
] as const)("does not retry HTTP %s", async (status, code) => {
  page(status, {});
  await expect(resolveMedia(config, signed)).rejects.toMatchObject({ code });
  expect(get).toHaveBeenCalledTimes(1);
});
it("distinguishes a 200 login screen from a public tutorial whose title starts with 登录", () => {
  expect(() =>
    parseXhsPage("<title>登录 - 小红书</title>" + desktop(note), id),
  ).toThrowError(expect.objectContaining({ code: "IDENTITY_LOGIN_REQUIRED" }));
  expect(() =>
    parseXhsPage("<title>安全验证</title>" + desktop(note), id),
  ).toThrowError(expect.objectContaining({ code: "UPSTREAM_RISK_CONTROL" }));
  expect(
    parseXhsPage("<title>登录界面设计 - 小红书</title>" + desktop(note), id)
      .slides,
  ).toHaveLength(2);
  expect(() =>
    parseXhsPage(
      mobile({ ...note, imageList: [{ url: img, stream: { h264: [{}] } }] }),
      id,
    ),
  ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_MEDIA" }));
});
it("bounds page bytes, checks IPs and isolates image, video and page hosts", async () => {
  page(200, { "content-type": "text/html" }, "x".repeat(4000001));
  await expect(resolveMedia(config, signed)).rejects.toMatchObject({
    code: "PROVIDER_PROTOCOL",
  });
  lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  await expect(resolveMedia(config, signed)).rejects.toMatchObject({
    code: "UNSAFE_URL",
  });
  for (const bad of [
    "http://xhslink.cn:8080/o/foo",
    "https://person@xhslink.cn/o/foo",
    "https://xhslink.cn.evil.test/o/foo",
    canonical.replace("explore", "user/profile"),
  ])
    expect(() => share(bad)).toThrow();
  for (const bad of [
    img.replace("http:", "https:").replace(".com/", ".com.evil.test/"),
    "https://www.xiaohongshu.com/file",
    video.replace("http:", "https:"),
  ])
    expect(() => checked(bad, "xhs-photo")).toThrow();
});
it("feeds note video and ordered stills through the real worker and returns JPEGs without retaining media", async () => {
  const root = mkdtempSync(join(tmpdir(), "lens-xhs-"));
  const kinds: string[] = [];
  const lens = new Lens(
    configSchema.parse({ cacheDir: root, ocrLang: "eng" }),
    {
      resolve: resolveMedia,
      worker,
      download: async (_u, p, _max, _signal, kind) => {
        kinds.push(kind!);
        const args =
          kind === "xhs-photo"
            ? ["-frames:v", "1", "-c:v", "png", "-f", "image2"]
            : ["-t", "2", "-c:v", "mpeg4", "-f", "mp4"];
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x96:rate=8",
          ...args,
          p,
        ]);
      },
    },
  );
  try {
    for (const [data, expected] of [
      [film, "video"],
      [note, "image_album"],
    ] as const) {
      page(200, { "content-type": "text/html" }, desktop(data));
      const job = lens.start(signed);
      expect((await job.done).status).toBe("COMPLETED");
      const result = lens.result(job.taskId);
      expect(result.media.kind).toBe(expected);
      expect(result.schemaVersion).toBe("1.1");
      expect(result.frames.length).toBeGreaterThan(0);
      expect(lens.image(job.taskId, { frameId: "f000" }).mimeType).toBe(
        "image/jpeg",
      );
      if (expected === "image_album")
        expect(result.frames.map((f) => [f.page, f.timestamp])).toEqual([
          [1, null],
          [2, null],
        ]);
      expect(
        readdirSync(lens.store.dir(job.taskId)).some(
          (f) => f.endsWith(".mp4") || f.startsWith(".page-"),
        ),
      ).toBe(false);
    }
    expect(kinds).toEqual(["xhs-stream", "xhs-photo", "xhs-photo"]);
  } finally {
    lens.store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
