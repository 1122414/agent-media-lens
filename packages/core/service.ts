import {
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  renameSync,
} from "node:fs";
import { z } from "zod";
import { configSchema, type Config } from "./config.js";
import { failure, LensError, type Media, type Evidence } from "./contracts.js";
import { share, download } from "./network.js";
import { resolveMedia } from "./providers.js";
import { worker } from "./processing.js";
import { Store } from "./storage.js";
const options = z
  .strictObject({
    discardOriginal: z.boolean().default(false),
    keepPlayback: z.boolean().default(false),
    provider: configSchema.shape.provider.removeDefault().optional(),
    maxFrames: configSchema.shape.maxFrames.removeDefault().optional(),
    model: configSchema.shape.model.removeDefault().optional(),
  })
  .refine(
    (o) => !(o.keepPlayback && o.discardOriginal),
    "保留播放副本与处理后删除不能同时指定",
  );
export type AnalyzeOptions = z.input<typeof options>;
export interface Result extends Evidence {
  schemaVersion: "1.0" | "1.1";
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
    let temporaryPlayback = false;
    let album = false;
    const done = (async () => {
      try {
        this.store.stage(id, "RESOLVING");
        const { media, stream, provider, slides } = await this.io.resolve(
          c,
          source,
          c.provider,
        );
        controller.signal.throwIfAborted();
        album = Boolean(slides);
        if (media.duration !== null && media.duration > c.maxSeconds)
          throw new LensError("DURATION_LIMIT", "超出视频时长限制");
        temporaryPlayback =
          !album &&
          (media.rendition === "public_playback" ||
            media.downloadPermission !== "allowed" ||
            opts.discardOriginal);
        const inputName = temporaryPlayback ? ".playback.mp4" : "source.mp4";
        if (slides) {
          if (opts.keepPlayback)
            throw new LensError(
              "UNSUPPORTED_OPTION",
              "图集仅保留逐页 JPEG 和 OCR 证据",
            );
          const needed =
            slides.length + 2 * slides.filter((slide) => slide.clip).length;
          if (needed > c.maxFrames)
            throw new LensError(
              "FRAME_LIMIT",
              "图集需要至少 " + needed + " 张证据图，请提高 maxFrames",
            );
          this.store.stage(id, "DOWNLOADING");
          let remaining = c.maxBytes;
          for (const [index, slide] of slides.entries()) {
            const prefix = ".page-" + String(index + 1).padStart(3, "0");
            const photo = this.store.file(id, prefix + ".img");
            await this.transfer(
              id,
              slide.poster,
              photo,
              remaining,
              controller.signal,
              "photo",
            );
            remaining -= statSync(photo).size;
            if (slide.clip) {
              const clip = this.store.file(id, prefix + ".mp4");
              await this.transfer(
                id,
                slide.clip,
                clip,
                remaining,
                controller.signal,
              );
              remaining -= statSync(clip).size;
            }
          }
        } else {
          if (!stream)
            throw new LensError(
              "MEDIA_WITHHELD",
              "作品详情可读，但访客未获得可用媒体",
            );
          this.store.stage(id, "DOWNLOADING");
          await this.transfer(
            id,
            stream,
            this.store.file(id, inputName),
            c.maxBytes,
            controller.signal,
          );
        }
        const evidence = await this.io.worker(
          this.store.dir(id),
          c,
          (s) => this.store.stage(id, s),
          controller.signal,
          (pid) => this.store.trackWorker(id, pid),
          temporaryPlayback,
          slides?.length,
        );
        controller.signal.throwIfAborted();
        const artifacts: Record<string, string> = {
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
              `- [${o.page ? "第 " + o.page + " 页 · " : ""}${o.timestamp == null ? "静态图" : o.timestamp + "s"} · ${o.frameId}] ${JSON.stringify(o.text)}`,
          ),
        ];
        writeFileSync(this.store.file(id, "analysis.md"), lines.join("\n"), {
          mode: 0o600,
        });
        if (album) this.store.clearAlbumInputs(id);
        else if (
          opts.discardOriginal ||
          (media.downloadPermission !== "allowed" && !opts.keepPlayback)
        )
          rmSync(this.store.file(id, inputName), { force: true });
        else if (temporaryPlayback) {
          renameSync(
            this.store.file(id, inputName),
            this.store.file(id, "playback.mp4"),
          );
          artifacts.playbackPath = "playback.mp4";
        } else artifacts.sourcePath = "source.mp4";
        this.store.transaction(() => {
          const completed = this.store.stage(id, "COMPLETED", { artifacts });
          const result: Result = {
            schemaVersion: album ? "1.1" : "1.0",
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
        let error = failure(err);
        if (album || temporaryPlayback) {
          try {
            if (album) this.store.clearAlbumInputs(id);
            rmSync(this.store.file(id, ".playback.mp4"), { force: true });
            rmSync(this.store.file(id, "playback.mp4"), { force: true });
          } catch {
            error = {
              code: "CLEANUP_FAILED",
              message: "清理原片失败，请检查缓存目录",
            };
          }
        }
        this.store.stage(
          id,
          controller.signal.aborted ? "CANCELLED" : "FAILED",
          { error },
        );
      } finally {
        this.active.delete(id);
      }
      return this.store.task(id);
    })();
    return { taskId: id, done };
  }
  private async transfer(
    id: string,
    url: string,
    path: string,
    max: number,
    signal: AbortSignal,
    kind: "stream" | "photo" = "stream",
  ) {
    if (max <= 0) throw new LensError("SIZE_LIMIT", "作品超出大小限制");
    const run = () => this.io.download(url, path, max, signal, kind);
    try {
      await run();
    } catch (err) {
      if (
        signal.aborted ||
        !["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(
          (err as NodeJS.ErrnoException).code || "",
        )
      )
        throw err;
      this.store.stage(id, "DOWNLOADING", {
        retries: this.store.task(id).retries + 1,
      });
      await run();
    }
  }
  cancelAll() {
    for (const c of this.active.values()) c.abort();
  }
  result(id: string): Result {
    const task = this.store.task(id);
    if (task.status !== "COMPLETED")
      throw new LensError("NOT_READY", "任务尚无可读结果");
    const data = JSON.parse(
      readFileSync(this.store.file(id, "result.json"), "utf8"),
    );
    if (data.schemaVersion !== "1.0" && data.schemaVersion !== "1.1")
      throw new LensError("SCHEMA_VERSION", "当前客户端不支持此版本，请升级");
    return { ...data, task, artifacts: task.artifacts ?? data.artifacts };
  }
  frames(id: string, start?: number, end?: number, page?: number) {
    const r = this.result(id);
    if (
      r.media.kind === "image_album" &&
      page === undefined &&
      (start !== undefined || end !== undefined)
    )
      throw new LensError("PAGE_REQUIRED", "图集的时间范围需要指定页码");
    return r.frames.filter(
      (f) =>
        (page === undefined || f.page === page) &&
        ((start === undefined && end === undefined) ||
          (f.timestamp !== null &&
            f.timestamp >= (start ?? 0) &&
            f.timestamp <= (end ?? Infinity))),
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
  image(
    id: string,
    selector: { frameId?: string; timestamp?: number; page?: number },
  ) {
    const frames = this.frames(
      id,
      selector.timestamp === undefined ? undefined : 0,
      undefined,
      selector.page,
    );
    const frame = selector.frameId
      ? frames.find((f) => f.id === selector.frameId)
      : frames.reduce<(typeof frames)[number] | undefined>(
          (near, f) =>
            !near ||
            Math.abs(f.timestamp! - selector.timestamp!) <
              Math.abs(near.timestamp! - selector.timestamp!)
              ? f
              : near,
          undefined,
        );
    if (!frame) throw new LensError("NOT_FOUND", "关键帧不存在");
    const path = this.store.file(id, frame.imagePath);
    if (statSync(path).size > 512000)
      throw new LensError("INVALID_IMAGE", "图片超限");
    const bytes = readFileSync(path);
    if (bytes.length > 512000 || bytes[0] !== 255 || bytes[1] !== 216)
      throw new LensError("INVALID_IMAGE", "图片格式或大小无效");
    return {
      type: "image" as const,
      mimeType: "image/jpeg",
      data: bytes.toString("base64"),
    };
  }
}
