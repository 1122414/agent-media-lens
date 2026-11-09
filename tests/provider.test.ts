import { it, expect, vi } from "vitest";
import { checked, share } from "../packages/core/network.js";
import { evil, normalize } from "../packages/core/providers.js";
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
it("maps duration and strips private raw data", () => {
  expect(normalize(data).media.duration).toBe(2.4);
  expect(normalize(data).media).not.toHaveProperty("raw");
});
it.each([
  { is_private: true },
  { kind: "image_album" },
  { raw: {} },
  { raw: { ...data.raw, video_control: { allow_download: false } } },
])("refuses restricted content", (patch) =>
  expect(() => normalize({ ...data, ...patch })).toThrow(),
);
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
