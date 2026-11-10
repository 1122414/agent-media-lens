import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
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
it("distinguishes measured cache usage from concurrent reservations at the quota boundary", () => {
  const config = {
    ...settings(),
    concurrency: 2,
    maxBytes: 1024,
    maxSeconds: 1,
    maxFrames: 1,
  };
  const reserve = 1024 + 32000 + 512000 + 8000000;
  const limit = 2 * reserve + 3;
  const store = new Store({ ...config, maxDiskBytes: limit });
  stores.push(store);
  const first = store.create();
  const file = store.file(first.taskId, "analysis.md");
  writeFileSync(file, "1234");
  expect(() => store.create()).toThrowError(
    expect.objectContaining({
      code: "DISK_LIMIT",
      details: { usedBytes: 4, requiredBytes: 2 * reserve, limitBytes: limit },
    }),
  );
  writeFileSync(file, "123");
  expect(store.create().status).toBe("PENDING");
});
it("distinguishes waiting, failed, and cancelled evidence reads without changing the public code", () => {
  const lens = new Lens(settings());
  stores.push(lens.store);
  const id = lens.store.create().taskId;
  for (const status of ["PENDING", "DOWNLOADING", "FAILED"] as const) {
    if (status !== "PENDING")
      lens.store.stage(
        id,
        status,
        status === "FAILED"
          ? { error: { code: "SIZE_LIMIT", message: "视频超出大小限制" } }
          : {},
      );
    for (const read of [
      () => lens.result(id),
      () => lens.frames(id),
      () => lens.transcript(id),
    ]) {
      expect(read).toThrowError(
        expect.objectContaining({
          code: "NOT_READY",
          details: {
            taskStatus: status,
            ...(status === "FAILED" ? { causeCode: "SIZE_LIMIT" } : {}),
          },
          message: expect.stringContaining(
            status === "FAILED" ? "SIZE_LIMIT — 视频超出大小限制" : status,
          ),
        }),
      );
    }
  }
  const cancelled = lens.store.create().taskId;
  lens.store.stage(cancelled, "CANCELLED");
  expect(() => lens.result(cancelled)).toThrowError(
    expect.objectContaining({
      code: "NOT_READY",
      details: { taskStatus: "CANCELLED" },
      message: expect.stringContaining("已取消"),
    }),
  );
});
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
  expect(lens.transcript(taskId)).toMatchObject({
    total: 0,
    status: "no_audio",
  });
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

it("formats the requested page of an older transcript without rewriting its evidence", () => {
  const lens = new Lens(settings());
  stores.push(lens.store);
  const id = lens.store.create().taskId;
  lens.store.stage(id, "COMPLETED", { artifacts: {} });
  const segments = [
    { start: 0, end: 1, text: "First" },
    { start: 1, end: 2, text: "two" },
    { start: 4, end: 5, text: "later" },
  ];
  writeFileSync(
    lens.store.file(id, "result.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      artifacts: {},
      transcript: { language: "en", text: "First two later", segments },
    }),
  );
  const full = lens.transcript(id);
  expect(full.displayText).toBe("First two\n\nlater");
  expect(full.segments).toEqual(segments);
  expect(full.status).toBeUndefined();
  const page = lens.transcript(id, 0, 5, 1, 1);
  expect(page.displayText).toBe("two");
  expect(page.nextOffset).toBe(2);
});

it("exports timestamped speech with the same display punctuation and preserves raw evidence", async () => {
  const text =
    "你好,继续吗? 温度1,500，路径 https://example.com/参数? 代码 `字段,字段` 不猜断句";
  const displayed =
    "你好，继续吗？ 温度1,500，路径 https://example.com/参数? 代码 `字段,字段` 不猜断句";
  const segments = [
    { start: 0.25, end: 6.75, text },
    { start: 8, end: 10, text: '看,他说"好"。' },
  ];
  const transcript = {
    language: "zh",
    text: segments.map((s) => s.text).join(" "),
    segments,
  };
  const lens = new Lens(settings(), {
    resolve: async () => ({
      provider: "fixture",
      stream: "fixture",
      media: {
        platform: "douyin",
        id: "123456789",
        sourceUrl: url,
        title: "Fixture",
        author: "Test",
        duration: 10,
      },
    }),
    download: async (_url, path) => {
      writeFileSync(path, "fixture");
    },
    worker: async () => ({ duration: 10, transcript, frames: [], ocr: [] }),
  });
  stores.push(lens.store);
  const job = lens.start(url);
  expect((await job.done).status).toBe("COMPLETED");
  const read = (file: string) =>
    readFileSync(lens.store.file(job.taskId, file), "utf8");
  expect(JSON.parse(read("transcript.json"))).toEqual(transcript);
  expect(lens.transcript(job.taskId)).toMatchObject({
    ...transcript,
    displayText: displayed + '\n\n看，他说"好"。',
  });
  const speech = read("analysis.md")
    .split("## Speech\n")[1]
    .split("\n\n## Frame text")[0];
  expect(speech.split("\n")).toEqual([
    "- [0.3–6.8s] " + JSON.stringify(displayed),
    "- [8.0–10.0s] " + JSON.stringify('看，他说"好"。'),
  ]);
});
