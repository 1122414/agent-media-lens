import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configSchema } from "../packages/core/config.js";
import { checked } from "../packages/core/network.js";
import { worker } from "../packages/core/processing.js";
import { normalize } from "../packages/core/providers.js";
import { Lens } from "../packages/core/service.js";

const url = "https://www.douyin.com/note/123456789";
const poster = "https://p3-pc-sign.douyinpic.com/poster",
  clip = "https://v11.douyinvod.com/live";
const album = {
  kind: "image_album",
  platform: "douyin",
  content_id: "123456789",
  title: "Test",
  author: { nickname: "test" },
  is_deleted: false,
  is_private: false,
  raw: {
    status: {
      private_status: 0,
      is_delete: false,
      is_prohibited: false,
      allow_share: true,
    },
  },
  media: {
    video: { url: "https://unused.example/background" },
    images: [{ url: poster }, { url: poster, video: { url: clip } }],
  },
};
it("validates public pages and keeps signed asset locations out of public metadata", () => {
  const found = normalize(album, url);
  expect(found.media.pages).toEqual([
    { page: 1, kind: "still" },
    { page: 2, kind: "live" },
  ]);
  expect(found.stream).toBeNull();
  expect(JSON.stringify(found.media)).not.toContain("douyinpic.com");
  expect(() => normalize({ ...album, is_private: true })).toThrow();
  expect(() =>
    normalize({
      ...album,
      media: { images: [{ url: "https://other.test/image" }] },
    }),
  ).toThrow();
  expect(() => checked(poster, "page")).toThrow();
  expect(() => checked(poster, "stream")).toThrow();
  expect(() =>
    checked(poster.replace(".com/", ".com.evil.test/"), "photo"),
  ).toThrow();
});
it("processes mixed pages with local timestamps, a shared byte limit and transient inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "lens-album-"));
  const c = configSchema.parse({ cacheDir: root, ocrLang: "eng" });
  const still = join(root, "test.png"),
    live = join(root, "test.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=120x80",
    "-frames:v",
    "1",
    still,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=120x80:r=10:d=2",
    "-c:v",
    "mpeg4",
    live,
  ]);
  const remaining: number[] = [];
  const lens = new Lens(c, {
    resolve: async () => ({ ...normalize(album, url), provider: "test" }),
    download: async (u, p, max) => {
      remaining.push(max);
      copyFileSync(u === poster ? still : live, p);
    },
    worker,
  });
  try {
    const task = lens.start(url);
    expect((await task.done).status).toBe("COMPLETED");
    expect(remaining[2]).toBeLessThan(remaining[1]);
    expect(remaining[1]).toBeLessThan(c.maxBytes);
    const r = lens.result(task.taskId);
    expect(r.duration).toBeNull();
    expect(r.schemaVersion).toBe("1.1");
    expect(r.frames.map((f) => f.page)).toEqual([1, 2, 2, 2]);
    expect(r.ocr.map((f) => f.timestamp)).toEqual(
      r.frames.map((f) => f.timestamp),
    );
    expect(
      lens.frames(task.taskId, undefined, undefined, 1)[0].timestamp,
    ).toBeNull();
    expect(() => lens.image(task.taskId, { timestamp: 0 })).toThrow();
    expect(lens.image(task.taskId, { page: 2, timestamp: 1 }).mimeType).toBe(
      "image/jpeg",
    );
    expect(
      readdirSync(lens.store.dir(task.taskId)).some((f) =>
        f.startsWith(".page-"),
      ),
    ).toBe(false);
    const small = lens.start(url, { maxFrames: 2 });
    expect((await small.done).error?.code).toBe("FRAME_LIMIT");
  } finally {
    lens.store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("removes preceding pages if a subsequent public asset fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "lens-album-fail-"));
  let n = 0;
  const lens = new Lens(configSchema.parse({ cacheDir: root }), {
    resolve: async () => ({ ...normalize(album, url), provider: "test" }),
    download: async (_u, p) => {
      if (n++) throw Error("failed");
      writeFileSync(p, "private temporary image");
    },
    worker,
  });
  try {
    const job = lens.start(url);
    expect((await job.done).status).toBe("FAILED");
    expect(existsSync(lens.store.file(job.taskId, ".page-001.img"))).toBe(
      false,
    );
  } finally {
    lens.store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
