import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { configSchema, type Config } from "./config.js";
import { failure, LensError, type Media, type Evidence } from "./contracts.js";
import { share, download } from "./network.js";
import { resolveMedia } from "./providers.js";
import { worker } from "./processing.js";
import { Store } from "./storage.js";
const options = z.strictObject({
  provider: configSchema.shape.provider.removeDefault().optional(),
  maxFrames: configSchema.shape.maxFrames.removeDefault().optional(),
  model: configSchema.shape.model.removeDefault().optional(),
});
export type AnalyzeOptions = z.input<typeof options>;
export interface Result extends Evidence {
  schemaVersion: "1.0";
  task: ReturnType<Store["task"]>;
  media: Media;
  provider: string;
  artifacts: Record<string, string>;
}
const services = { resolve: resolveMedia, download, worker };
export class Lens {
  readonly store: Store;
  private readonly active = new Map<string, AbortController>();
  constructor(
    readonly settings: Config,
    private readonly io = services,
  ) {
    this.store = new Store(settings);
  }
  async resolve(url: string, provider = this.settings.provider) {
    const r = await this.io.resolve(this.settings, url, provider);
    return { provider: r.provider, media: r.media };
  }
  start(url: string, input: AnalyzeOptions = {}) {
    const source = share(url),
      opts = options.parse(input),
      c = { ...this.settings, ...opts };
    c.maxFrames = Math.min(c.maxFrames, this.settings.maxFrames);
    const task = this.store.create(),
      id = task.taskId,
      controller = new AbortController();
    this.active.set(id, controller);
    const done = (async () => {
      try {
        this.store.stage(id, "RESOLVING");
        const { media, stream, provider } = await this.io.resolve(
          c,
          source,
          c.provider,
        );
        controller.signal.throwIfAborted();
        if (media.duration !== null && media.duration > c.maxSeconds)
          throw new LensError("DURATION_LIMIT", "超出视频时长限制");
        this.store.stage(id, "DOWNLOADING");
        await this.io.download(
          stream,
          this.store.file(id, "source.mp4"),
          c.maxBytes,
        );
        const evidence = await this.io.worker(
          this.store.dir(id),
          c,
          (s) => this.store.stage(id, s),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        const artifacts = {
          metadataPath: "result.json",
          transcriptPath: "transcript.json",
          analysisPath: "analysis.md",
        };
        writeFileSync(
          this.store.file(id, "transcript.json"),
          JSON.stringify(evidence.transcript),
          { mode: 0o600 },
        );
        const lines = [
          "# Media evidence",
          JSON.stringify(media.title),
          media.sourceUrl,
          "",
          "## Speech",
          ...evidence.transcript.segments.map(
            (s) =>
              `- [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${JSON.stringify(s.text)}`,
          ),
          "",
          "## Frame text",
          ...evidence.ocr.map(
            (o) =>
              `- [${o.timestamp}s · ${o.frameId}] ${JSON.stringify(o.text)}`,
          ),
        ];
        writeFileSync(this.store.file(id, "analysis.md"), lines.join("\n"), {
          mode: 0o600,
        });
        this.store.transaction(() => {
          const completed = this.store.stage(id, "COMPLETED", { artifacts });
          const result: Result = {
            schemaVersion: "1.0",
            media: { ...media, duration: evidence.duration },
            provider,
            ...evidence,
            task: completed,
            artifacts,
          };
          writeFileSync(
            this.store.file(id, "result.json"),
            JSON.stringify(result),
            { mode: 0o600 },
          );
        });
      } catch (err) {
        this.store.stage(
          id,
          controller.signal.aborted ? "CANCELLED" : "FAILED",
          { error: failure(err) },
        );
      } finally {
        this.active.delete(id);
      }
      return this.store.task(id);
    })();
    return { taskId: id, done };
  }
  cancelAll() {
    for (const c of this.active.values()) c.abort();
  }
  result(id: string): Result {
    if (this.store.task(id).status !== "COMPLETED")
      throw new LensError("NOT_READY", "任务尚无可读结果");
    const data = JSON.parse(
      readFileSync(this.store.file(id, "result.json"), "utf8"),
    );
    if (data.schemaVersion !== "1.0")
      throw new LensError("SCHEMA_VERSION", "当前客户端不支持此版本，请升级");
    return data;
  }
  frames(id: string, start = 0, end = Infinity) {
    return this.result(id).frames.filter(
      (f) => f.timestamp >= start && f.timestamp <= end,
    );
  }
  transcript(id: string, start = 0, end = Infinity, offset = 0, limit = 100) {
    const t = this.result(id).transcript;
    const all = t.segments.filter((s) => s.end >= start && s.start <= end);
    const segments = all.slice(offset, offset + limit);
    return {
      language: t.language,
      text: segments.map((s) => s.text).join(" "),
      segments,
      total: all.length,
      nextOffset:
        offset + segments.length < all.length ? offset + segments.length : null,
    };
  }
  image(id: string, selector: { frameId?: string; timestamp?: number }) {
    const frames = this.frames(id);
    const frame = selector.frameId
      ? frames.find((f) => f.id === selector.frameId)
      : frames.reduce<(typeof frames)[number] | undefined>(
          (near, f) =>
            !near ||
            Math.abs(f.timestamp - selector.timestamp!) <
              Math.abs(near.timestamp - selector.timestamp!)
              ? f
              : near,
          undefined,
        );
    if (!frame) throw new LensError("NOT_FOUND", "关键帧不存在");
    const bytes = readFileSync(this.store.file(id, frame.imagePath));
    if (bytes.length > 512000 || bytes[0] !== 255 || bytes[1] !== 216)
      throw new LensError("INVALID_IMAGE", "图片格式或大小无效");
    return {
      type: "image" as const,
      mimeType: "image/jpeg",
      data: bytes.toString("base64"),
    };
  }
}
