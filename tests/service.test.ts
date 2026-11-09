import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  utimesSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { configSchema } from "../packages/core/config.js";
import { Lens } from "../packages/core/service.js";
import { worker } from "../packages/core/processing.js";
import { Store } from "../packages/core/storage.js";
const dirs: string[] = [];
const stores: Store[] = [];
function settings() {
  const cacheDir = mkdtempSync(join(tmpdir(), "lens-test-"));
  dirs.push(cacheDir);
  return configSchema.parse({ cacheDir, ocrLang: "eng" });
}
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const url = "https://www.douyin.com/video/123456789";
it("processes a real silent clip, reads evidence, guards active files and expires originals", async () => {
  const c = settings();
  let attempts = 0;
  const lens = new Lens(c, {
    resolve: async () => ({
      media: {
        platform: "douyin",
        downloadPermission: "allowed",
        id: "123456789",
        sourceUrl: url,
        title: "Test clip",
        author: "Fixture",
        duration: 2,
      },
      stream: "fixture",
      provider: "test",
    }),
    download: async (_u, path) => {
      if (attempts++ === 0)
        throw Object.assign(new Error("connection reset"), {
          code: "ECONNRESET",
        });
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10:duration=2",
        "-c:v",
        "mpeg4",
        path,
      ]);
    },
    worker,
  });
  stores.push(lens.store);
  const { taskId, done } = lens.start(url);
  expect(() => lens.start(url)).toThrow("并发");
  expect(lens.store.cleanup().removed).toBe(0);
  expect((await done).status).toBe("COMPLETED");
  expect(lens.store.task(taskId).retries).toBe(1);
  expect(lens.transcript(taskId).total).toBe(0);
  expect(lens.frames(taskId).length).toBeGreaterThan(0);
  expect(
    Buffer.from(lens.image(taskId, { frameId: "f000" }).data, "base64")
      .subarray(0, 2)
      .toString("hex"),
  ).toBe("ffd8");
  const path = lens.store.file(taskId, "source.mp4");
  expect(lens.result(taskId).artifacts.sourcePath).toBe("source.mp4");
  utimesSync(path, new Date(0), new Date(0));
  expect(lens.store.cleanup().removed).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(lens.result(taskId).artifacts.sourcePath).toBeUndefined();
  expect(lens.result(taskId).schemaVersion).toBe("1.0");
  const ephemeral = lens.start(url, { discardOriginal: true });
  expect((await ephemeral.done).status).toBe("COMPLETED");
  expect(existsSync(lens.store.file(ephemeral.taskId, "source.mp4"))).toBe(
    false,
  );
  symlinkSync(
    join(c.cacheDir, "missing"),
    lens.store.file(taskId, "audio.wav"),
  );
  expect(() => lens.store.file(taskId, "audio.wav")).toThrow("任务文件无效");
}, 20000);
it.each(["allowed", "disabled"] as const)(
  "keeps a playback copy only on request (permission %s), then reports its expiry",
  async (permission) => {
    const lens = new Lens(settings(), {
      resolve: async () => ({
        provider: "test",
        stream: "public-playback",
        media: {
          platform: "douyin",
          id: "123456789",
          sourceUrl: url,
          title: "Test",
          author: "Test",
          duration: 2,
          downloadPermission: permission,
          rendition: "public_playback",
        },
      }),
      download: async (_url, path) => {
        writeFileSync(path, "guest rendition");
      },
      worker: async () => ({
        duration: 2,
        transcript: { language: null, text: "", segments: [] },
        frames: [],
        ocr: [],
      }),
    });
    stores.push(lens.store);
    expect(() =>
      lens.start(url, { keepPlayback: true, discardOriginal: true }),
    ).toThrow();
    const ephemeral = lens.start(url);
    expect((await ephemeral.done).status).toBe("COMPLETED");
    expect(
      lens.result(ephemeral.taskId).artifacts.playbackPath,
    ).toBeUndefined();
    expect(lens.result(ephemeral.taskId).retained).toBe(false);
    expect(existsSync(lens.store.file(ephemeral.taskId, ".playback.mp4"))).toBe(
      false,
    );
    const job = lens.start(url, { keepPlayback: true });
    expect((await job.done).status).toBe("COMPLETED");
    const result = lens.result(job.taskId);
    expect(result.artifacts.playbackPath).toBe("playback.mp4");
    expect(result.retained).toBe(true);
    expect(result.artifacts.sourcePath).toBeUndefined();
    const path = lens.store.file(job.taskId, result.artifacts.playbackPath);
    utimesSync(path, new Date(0), new Date(0));
    expect(lens.store.cleanup().removed).toBe(1);
    expect(lens.result(job.taskId).artifacts.playbackPath).toBeUndefined();
  },
);
it("returns public metadata and never retains a playback-only input after decoder failure", async () => {
  const c = settings();
  const lens = new Lens(c, {
    resolve: async () => ({
      provider: "test",
      stream: "public-playback",
      media: {
        platform: "douyin",
        id: "123456789",
        sourceUrl: url,
        title: "Test",
        author: "Test",
        duration: 2,
        downloadPermission: "disabled",
      },
    }),
    download: async (_url, file) => {
      expect(file.endsWith("/.playback.mp4")).toBe(true);
      writeFileSync(file, "partial");
    },
    worker: async () => {
      throw new Error("decode failure");
    },
  });
  stores.push(lens.store);
  const metadata = await lens.resolve(url);
  expect(metadata.media.downloadPermission).toBe("disabled");
  expect(metadata).not.toHaveProperty("stream");
  const job = lens.start(url);
  expect((await job.done).status).toBe("FAILED");
  for (const name of [".playback.mp4", "source.mp4"])
    expect(existsSync(lens.store.file(job.taskId, name))).toBe(false);
});
it("rejects traversal and records a provider failure", async () => {
  const lens = new Lens(settings());
  stores.push(lens.store);
  expect(() => lens.store.dir("../")).toThrow();
  const job = lens.start(url, { provider: "native" });
  expect((await job.done).error?.code).toBe("NATIVE_UNSUPPORTED");
  expect(() => lens.result(job.taskId)).toThrow();
});

it("recovers abandoned tasks while protecting an active worker group", () => {
  const c = settings(),
    store = new Store(c);
  stores.push(store);
  const job = store.create();
  store.db
    .prepare("UPDATE tasks SET pid=? WHERE id=?")
    .run(2147483647, job.taskId);
  // A fresh process group stands in for the orphan worker during parent recovery.
  writeFileSync(
    store.file(job.taskId, ".playback.mp4"),
    "partial guest playback",
  );
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    store.trackWorker(job.taskId, child.pid!);
    store.cleanup();
    expect(store.task(job.taskId).status).toBe("PENDING");
    store.trackWorker(job.taskId, 2147483647);
    store.cleanup();
    expect(store.task(job.taskId).error?.code).toBe("INTERRUPTED");
    expect(existsSync(store.file(job.taskId, ".playback.mp4"))).toBe(false);
  } finally {
    child.kill();
  }
});

it("reports both durations and the configuration hint before downloading an overlong video", async () => {
  const c = settings();
  const lens = new Lens(c, {
    resolve: async () => ({
      provider: "fixture",
      stream: "unused",
      media: {
        platform: "douyin",
        id: "123456789",
        sourceUrl: url,
        title: "fixture",
        author: "test",
        duration: 601,
      },
    }),
    download: async () => {
      throw new Error("download must not run");
    },
    worker,
  });
  stores.push(lens.store);
  const task = await lens.start(url).done;
  expect(task.error).toMatchObject({
    code: "DURATION_LIMIT",
    message: expect.stringMatching(/601.0s.*600s.*maxSeconds/),
  });
  expect(task.stages.map((s) => s.stage)).not.toContain("DOWNLOADING");
});
