import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { configSchema } from "../packages/core/config.js";
import { diagnostics } from "../packages/core/diagnostics.js";
import { fetchPublic, download } from "../packages/core/network.js";
import { failure } from "../packages/core/contracts.js";
import { Lens } from "../packages/core/service.js";
import { projectRoot, worker } from "../packages/core/processing.js";

const { get, lookup, sleep } = vi.hoisted(() => ({
  get: vi.fn(),
  lookup: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("node:https", () => ({ get }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:timers/promises", () => ({ setTimeout: sleep }));
const signed = "https://v1.douyinvod.com/private-name?token=DO_NOT_LOG";
const fresh = () => new AbortController().signal;
function reply(statusCode: number, headers: Record<string, string> = {}) {
  get.mockImplementationOnce((_url, _opts, cb) => {
    cb(Object.assign(Readable.from(["content"]), { statusCode, headers }));
    return new EventEmitter();
  });
}
beforeEach(() => {
  get.mockReset();
  lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  sleep.mockReset().mockResolvedValue(undefined);
});
it.each([
  [401, "HTTP_ACCESS_DENIED"],
  [403, "HTTP_ACCESS_DENIED"],
  [404, "HTTP_NOT_FOUND"],
  [410, "HTTP_NOT_FOUND"],
  [501, "HTTP_SERVER_ERROR"],
] as const)("stops on HTTP %i with only safe context", async (status, code) => {
  reply(status);
  const err = await fetchPublic(signed, "stream", fresh()).catch(failure);
  expect(err).toMatchObject({
    code,
    httpStatus: status,
    hostname: "v1.douyinvod.com",
  });
  expect(JSON.stringify(err)).not.toMatch(/private-name|DO_NOT_LOG/);
  expect(get).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});
it("honors Retry-After, bounds attempts across redirects, and redacts signed URLs", async () => {
  const events: unknown[] = [];
  const log = (e: unknown) => events.push(e);
  diagnostics.subscribe(log);
  try {
    for (const status of [429, 503, 502]) {
      reply(302, {
        location: "https://v2.douyinvod.com/redir-secret?q=sample-secret",
      });
      reply(status, status === 429 ? { "retry-after": "3" } : {});
    }
    const err = await fetchPublic(signed, "stream", fresh()).catch(failure);
    expect(err).toMatchObject({
      httpStatus: 502,
      hostname: "v2.douyinvod.com",
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000, 4000]);
    expect(get).toHaveBeenCalledTimes(6);
    expect(lookup).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual({
      event: "redirect",
      fromHost: "v1.douyinvod.com",
      toHost: "v2.douyinvod.com",
      hop: 1,
    });
    expect(JSON.stringify(events)).not.toMatch(
      /private-name|DO_NOT_LOG|redir-secret|sample-secret/,
    );
  } finally {
    diagnostics.unsubscribe(log);
  }
});
it("stops instead of shortening a long Retry-After or retrying a Xiaohongshu refusal", async () => {
  reply(429, { "retry-after": new Date(Date.now() + 60000).toUTCString() });
  await expect(fetchPublic(signed, "stream", fresh())).rejects.toMatchObject({
    httpStatus: 429,
    retryAfterSeconds: expect.any(Number),
  });
  reply(429);
  await expect(
    fetchPublic("https://sns-video-bd.xhscdn.com/a", "xhs-stream", fresh()),
  ).rejects.toMatchObject({ code: "RATE_LIMITED", httpStatus: 429 });
  expect(sleep).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(2);
});
it("cancels a backoff before another request", async () => {
  const controller = new AbortController();
  reply(503);
  sleep.mockImplementationOnce(() => {
    controller.abort();
    return Promise.reject(controller.signal.reason);
  });
  await expect(
    fetchPublic(signed, "stream", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(get).toHaveBeenCalledTimes(1);
});
it("records actual HTTP retries in the media task and retains the terminal HTTP diagnosis", async () => {
  const cache = mkdtempSync(join(tmpdir(), "lens-http-"));
  const url = "https://www.douyin.com/video/123456789";
  const lens = new Lens(configSchema.parse({ cacheDir: cache }), {
    download,
    worker,
    resolve: async () => ({
      provider: "fixture",
      stream: signed,
      media: {
        id: "123456789",
        platform: "douyin",
        sourceUrl: url,
        title: "fixture",
        author: "fixture",
        duration: 1,
      },
    }),
  });
  try {
    reply(503);
    reply(403);
    const task = await lens.start(url).done;
    expect(task).toMatchObject({
      status: "FAILED",
      retries: 1,
      error: {
        code: "HTTP_ACCESS_DENIED",
        hostname: "v1.douyinvod.com",
        httpStatus: 403,
      },
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000]);
    reply(503);
    reply(200);
    const result = await fetchPublic(signed, "stream", fresh());
    expect(result.res.statusCode).toBe(200);
    result.res.destroy();
  } finally {
    lens.store.db.close();
    rmSync(cache, { recursive: true, force: true });
  }
});
it("CLI emits opt-in provider and timed stage events, preserving JSON stdout", () => {
  const cache = mkdtempSync(join(tmpdir(), "lens-verbose-"));
  try {
    for (const verbose of [false, true]) {
      const r = spawnSync(
        process.execPath,
        [
          join(projectRoot, "dist/apps/cli/main.js"),
          ...(verbose ? ["--verbose"] : []),
          "analyze",
          "https://www.douyin.com/video/123456789?redacted=secret",
          "--provider",
          "native",
        ],
        { env: { ...process.env, MEDIA_LENS_CACHE: cache }, encoding: "utf8" },
      );
      expect(JSON.parse(r.stdout).error.code).toBe("NATIVE_UNSUPPORTED");
      const events = r.stderr
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));
      if (!verbose) expect(events).toHaveLength(0);
      else {
        expect(events).toContainEqual({
          event: "provider",
          provider: "native",
          platform: "douyin",
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "stage",
            stage: "FAILED",
            previousStage: "RESOLVING",
            elapsedMs: expect.any(Number),
          }),
        );
        expect(r.stderr).not.toContain("secret");
      }
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

it("sends the fixed Douyin referer to its video CDN only, recomputing it on redirects", async () => {
  reply(302, { location: "https://www.douyin.com/play" });
  reply(200);
  const { res } = await fetchPublic(signed, "stream", fresh());
  res.destroy();
  expect(get.mock.calls.map((c) => c[1].headers.referer)).toEqual([
    "https://www.douyin.com/",
    undefined,
  ]);
});

it.each([
  ["mirror", 2, 1, "COMPLETED"],
  ["refresh", 3, 2, "COMPLETED"],
  ["all-denied", 3, 2, "FAILED"],
  ["refresh-duplicate", 2, 2, "FAILED"],
  ["refresh-permission-change", 2, 2, "FAILED"],
  ["refresh-different-post", 2, 2, "FAILED"],
  ["401", 1, 1, "FAILED"],
  ["non-cdn-403", 1, 1, "FAILED"],
] as const)(
  "recovers only matching public renditions: %s",
  async (mode, attempts, resolves, status) => {
    const cache = mkdtempSync(join(tmpdir(), "lens-cdn-"));
    const url = "https://www.douyin.com/video/123456789";
    const media = {
      id: "123456789",
      platform: "douyin" as const,
      sourceUrl: url,
      title: "t",
      author: "a",
      duration: 1,
      rendition: "public_playback" as const,
      downloadPermission: "disabled" as const,
    };
    const primary =
      mode === "non-cdn-403" ? "https://www.douyin.com/play" : signed;
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        media,
        provider: "evil0ctal",
        stream: primary,
        alternateStreams: [signed + "2"],
      })
      .mockResolvedValue({
        media: {
          ...media,
          ...(mode === "refresh-permission-change"
            ? { downloadPermission: "allowed" }
            : mode === "refresh-different-post"
              ? { id: "999999999" }
              : {}),
        },
        provider: "evil0ctal",
        stream: mode === "refresh-duplicate" ? signed : signed + "3",
      });
    const lens = new Lens(configSchema.parse({ cacheDir: cache }), {
      download,
      resolve,
      worker: async () => ({
        duration: 1,
        transcript: { language: null, text: "", segments: [] },
        frames: [],
        ocr: [],
      }),
    });
    try {
      for (let i = 0; i < attempts; i++)
        reply(
          mode === "401"
            ? 401
            : i === attempts - 1 && status === "COMPLETED"
              ? 200
              : 403,
        );
      const job = lens.start(url),
        task = await job.done;
      expect(task.status).toBe(status);
      expect(resolve).toHaveBeenCalledTimes(resolves);
      expect(get.mock.calls.map((c) => c[0].href)).toEqual(
        [primary, signed + "2", signed + "3"].slice(0, attempts),
      );
      expect(sleep).not.toHaveBeenCalled();
      if (status === "COMPLETED") {
        expect(lens.result(job.taskId).retained).toBe(false);
        expect(JSON.stringify(lens.result(job.taskId))).not.toContain(
          "DO_NOT_LOG",
        );
      } else expect(task.error?.code).toBe("HTTP_ACCESS_DENIED");
    } finally {
      lens.store.db.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
