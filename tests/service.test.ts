import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  const lens = new Lens(c, {
    resolve: async () => ({
      media: {
        platform: "douyin",
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
  expect(lens.transcript(taskId).total).toBe(0);
  expect(lens.frames(taskId).length).toBeGreaterThan(0);
  expect(
    Buffer.from(lens.image(taskId, { frameId: "f000" }).data, "base64")
      .subarray(0, 2)
      .toString("hex"),
  ).toBe("ffd8");
  const path = lens.store.file(taskId, "source.mp4");
  utimesSync(path, new Date(0), new Date(0));
  expect(lens.store.cleanup().removed).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(lens.result(taskId).schemaVersion).toBe("1.0");
}, 20000);
it("rejects traversal and records a provider failure", async () => {
  const lens = new Lens(settings());
  stores.push(lens.store);
  expect(() => lens.store.dir("../")).toThrow();
  const job = lens.start(url, { provider: "native" });
  expect((await job.done).error?.code).toBe("NATIVE_UNSUPPORTED");
  expect(() => lens.result(job.taskId)).toThrow();
});
