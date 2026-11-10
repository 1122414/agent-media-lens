import {
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  renameSync,
} from "node:fs";
import { z } from "zod";
import { configSchema, type Config } from "./config.js";
import {
  durationLimit,
  failure,
  LensError,
  mediaSizeLimit,
  PublicHttpError,
  type Candidate,
  type Media,
  type Evidence,
} from "./contracts.js";
import { trace } from "./diagnostics.js";
import {
  share,
  download,
  retryPublicRead,
  isDouyinVod,
  type AssetKind,
} from "./network.js";
import { resolveMedia } from "./providers.js";
import { worker } from "./processing.js";
import { Store } from "./storage.js";
const options = z
  .strictObject({
    discardOriginal: z.boolean().default(false),
    keepPlayback: z.boolean().default(false),
    provider: configSchema.shape.provider.removeDefault().optional(),
    maxFrames: configSchema.shape.maxFrames.removeDefault().optional(),
    asrHotwords: configSchema.shape.asrHotwords.removeDefault().optional(),
    asrPrompt: configSchema.shape.asrPrompt.removeDefault().optional(),
    asrFallback: z.boolean().optional(),
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
  platformDuration?: number | null;
  fileDuration?: number | null;
  provider: string;
  retained?: boolean;
  artifacts: Record<string, string>;
}
type FrameSelector = { frameId?: string; timestamp?: number; page?: number };
function filterFrames(r: Result, start?: number, end?: number, page?: number) {
  if (r.media.kind !== "image_album" && page !== undefined)
    throw new LensError("PAGE_NOT_APPLICABLE", "视频没有图集页码，请移除 page");
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
function displaySpeech(text: string, language: string | null) {
  return language === "zh"
    ? text.replace(
        /https?:\/\/\S+|`[^`]*`|(?<=\p{Script=Han})[,?](?=\s*(?:\p{Script=Han}|$))/gu,
        (token) => (token === "," ? "，" : token === "?" ? "？" : token),
      )
    : text;
}

const services = { resolve: resolveMedia, download, worker };
export class Lens {
  readonly store: Store;
  private readonly active = new Map<string, AbortController>();
  constructor(
    readonly settings: Config,
    private readonly io = services,
  ) {
    try {
      this.store = new Store(settings);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { errcode?: number };
      if (
        ["ENOTDIR", "EISDIR", "EACCES", "EPERM", "EROFS", "EEXIST"].includes(
          e.code ?? "",
        ) ||
        (e.code === "ERR_SQLITE_ERROR" &&
          [8, 14].includes((e.errcode ?? 0) & 255))
      )
        throw new LensError(
          "CACHE_UNWRITABLE",
          "无法创建或写入本地任务缓存。请检查目录权限，或用 MEDIA_LENS_CACHE 指定可写目录",
        );
      throw err;
    }
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
        const candidate = await this.io.resolve(
          c,
          source,
          c.provider,
          controller.signal,
          () => this.markRetry(id),
        );
        controller.signal.throwIfAborted();
        const { media, stream, provider, slides } = candidate;
        album = Boolean(slides);
        trace({
          event: "rendition",
          platform: media.platform,
          kind: album ? "image_album" : (media.rendition ?? "unspecified"),
        });
        if (media.duration !== null && media.duration > c.maxSeconds)
          throw durationLimit(media.duration, c.maxSeconds);
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
              media.platform === "xiaohongshu" ? "xhs-photo" : "photo",
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
          const path = this.store.file(id, inputName);
          if (
            media.platform === "douyin" &&
            provider === "evil0ctal" &&
            media.rendition
          ) {
            await this.transferDouyinVideo(
              id,
              candidate,
              path,
              c,
              controller.signal,
            );
          } else {
            await this.transfer(
              id,
              stream,
              path,
              c.maxBytes,
              controller.signal,
              media.platform === "xiaohongshu"
                ? "xhs-stream"
                : media.platform === "bilibili"
                  ? "bili-stream"
                  : "stream",
            );
          }
        }
        const evidence = await this.io.worker(
          this.store.dir(id),
          c,
          (s) => this.store.stage(id, s),
          controller.signal,
          (pid) => this.store.trackWorker(id, pid),
          temporaryPlayback,
          slides?.length,
          media.platform,
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
        const outroFrames = new Set(
          evidence.frames
            .filter((f) => f.role === "possible_platform_outro")
            .map((f) => f.id),
        );
        const lines = [
          "# Media evidence",
          JSON.stringify(media.title),
          media.sourceUrl,
          "",
          "## Speech",
          ...(evidence.transcript.status
            ? [`Status: ${evidence.transcript.status}`]
            : []),
          ...(evidence.warnings ?? []).map((w) => `Warning: ${w}`),
          ...evidence.transcript.segments.map(
            (s) =>
              `- [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${JSON.stringify(displaySpeech(s.text, evidence.transcript.language))}`,
          ),
          "",
          "## Frame text",
          ...evidence.ocr
            .filter((o) => o.text && !o.repeatedOf)
            .map(
              (o) =>
                `- [${o.page ? "第 " + o.page + " 页 · " : ""}${o.timestamp == null ? "静态图" : o.timestamp + "s"} · ${o.frameId}${outroFrames.has(o.frameId) ? " · 疑似平台片尾" : ""}] ${JSON.stringify(o.text)}`,
            ),
        ];
        writeFileSync(this.store.file(id, "analysis.md"), lines.join("\n"), {
          mode: 0o600,
        });
        if (album) this.store.clearAlbumInputs(id);
        else if (
          opts.discardOriginal ||
          (temporaryPlayback && !opts.keepPlayback)
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
          const completed = this.store.stage(id, "COMPLETED", {
            artifacts,
            warnings: evidence.warnings,
          });
          const result: Result = {
            schemaVersion: album || media.platform !== "douyin" ? "1.1" : "1.0",
            retained: Boolean(artifacts.sourcePath || artifacts.playbackPath),
            platformDuration: media.duration,
            fileDuration: evidence.duration,
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
  private async transferDouyinVideo(
    id: string,
    candidate: Candidate,
    path: string,
    c: Config,
    signal: AbortSignal,
  ) {
    const media = candidate.media;
    const urls = (r: Candidate) =>
      [...new Set([r.stream, ...(r.alternateStreams ?? [])])].filter(
        (u): u is string => Boolean(u),
      );
    const attempted = new Set<string>();
    let queue = urls(candidate).slice(0, 3);
    let refreshed = false;
    for (;;) {
      const url = queue.shift();
      if (!url) throw new LensError("MEDIA_WITHHELD", "未获得可用媒体");
      attempted.add(url);
      try {
        await this.transfer(id, url, path, c.maxBytes, signal);
        return;
      } catch (err) {
        if (
          !(err instanceof PublicHttpError) ||
          err.httpStatus !== 403 ||
          !isDouyinVod(err.hostname)
        )
          throw err;
        signal.throwIfAborted();
        if (!queue.length && !refreshed) {
          refreshed = true;
          const next = await this.io.resolve(
            c,
            media.sourceUrl,
            "evil0ctal",
            signal,
          );
          signal.throwIfAborted();
          if (
            next.provider !== "evil0ctal" ||
            next.media.platform !== media.platform ||
            next.media.id !== media.id ||
            next.media.rendition !== media.rendition ||
            next.media.downloadPermission !== media.downloadPermission ||
            next.slides
          )
            throw err;
          if (
            next.media.duration !== null &&
            next.media.duration > c.maxSeconds
          )
            throw durationLimit(next.media.duration, c.maxSeconds);
          queue = urls(next)
            .filter((u) => !attempted.has(u))
            .slice(0, 1);
        }
        if (!queue.length) throw err;
        this.markRetry(id);
        trace({
          event: "retry",
          code: refreshed ? "CDN_REFRESH" : "CDN_ALTERNATE",
          hostname: err.hostname,
          httpStatus: 403,
          attempt: attempted.size + 1,
          delayMs: 0,
        });
      }
    }
  }
  private async transfer(
    id: string,
    url: string,
    path: string,
    max: number,
    signal: AbortSignal,
    kind: AssetKind = "stream",
  ) {
    if (max <= 0) throw mediaSizeLimit(this.settings.maxBytes, 0);
    return retryPublicRead(
      () =>
        this.io.download(url, path, max, signal, kind, this.settings.maxBytes),
      signal,
      () => this.markRetry(id),
      true,
    );
  }
  private markRetry(id: string) {
    const task = this.store.task(id);
    this.store.stage(id, task.status, { retries: task.retries + 1 });
  }
  cancelAll() {
    for (const c of this.active.values()) c.abort();
  }
  result(id: string): Result {
    const task = this.store.task(id);
    if (task.status !== "COMPLETED") {
      const details = { taskStatus: task.status };
      if (task.status === "FAILED") {
        const cause = task.error;
        throw new LensError(
          "NOT_READY",
          cause
            ? `任务已失败：${cause.code} — ${cause.message}`
            : "任务已失败，无可读结果",
          { ...details, causeCode: cause?.code },
        );
      }
      if (task.status === "CANCELLED")
        throw new LensError("NOT_READY", "任务已取消，无可读结果", details);
      throw new LensError(
        "NOT_READY",
        `任务尚无可读结果（${task.status}），请稍后查询任务状态`,
        details,
      );
    }
    const data = JSON.parse(
      readFileSync(this.store.file(id, "result.json"), "utf8"),
    );
    if (data.schemaVersion !== "1.0" && data.schemaVersion !== "1.1")
      throw new LensError("SCHEMA_VERSION", "当前客户端不支持此版本，请升级");
    const artifacts = task.artifacts ?? data.artifacts;
    return {
      ...data,
      task,
      artifacts,
      retained: Boolean(artifacts.sourcePath || artifacts.playbackPath),
    };
  }
  frames(id: string, start?: number, end?: number, page?: number) {
    return filterFrames(this.result(id), start, end, page);
  }
  transcript(id: string, start = 0, end = Infinity, offset = 0, limit = 100) {
    const t = this.result(id).transcript;
    const all = t.segments.filter((s) => s.end >= start && s.start <= end);
    const segments = all.slice(offset, offset + limit);
    const paragraphs: string[] = [];
    let previousEnd = -Infinity;
    for (const s of segments) {
      const display = displaySpeech(s.text, t.language);
      if (
        s.start - previousEnd >= 1 ||
        !paragraphs.length ||
        paragraphs[paragraphs.length - 1].length >= 120
      )
        paragraphs.push(display);
      else paragraphs[paragraphs.length - 1] += " " + display;
      previousEnd = s.end;
    }
    return {
      language: t.language,
      status: t.status,
      model: t.model,
      device: t.device,
      warning: t.warning,
      displayText: paragraphs.join("\n\n"),
      text: segments.map((s) => s.text).join(" "),
      segments,
      total: all.length,
      nextOffset:
        offset + segments.length < all.length ? offset + segments.length : null,
    };
  }
  image(id: string, selector: FrameSelector) {
    return this.frameImage(id, selector).image;
  }
  frameImage(id: string, { frameId, timestamp, page }: FrameSelector) {
    const r = this.result(id);
    const frames = filterFrames(
      r,
      timestamp === undefined ? undefined : 0,
      undefined,
      page,
    );
    if ((frameId === undefined) === (timestamp === undefined))
      throw new LensError("INVALID_SELECTOR", "请选择帧 ID 或时间戳");
    if (timestamp !== undefined) {
      const duration =
        r.media.kind === "image_album" ? null : (r.fileDuration ?? r.duration);
      const upper =
        duration ??
        (frames.length ? Math.max(...frames.map((f) => f.timestamp!)) : null);
      if (!Number.isFinite(timestamp) || timestamp < 0)
        throw new LensError("INVALID_SELECTOR", "时间戳必须是非负有限秒数");
      if (upper !== null && timestamp > upper)
        throw new LensError(
          "INVALID_SELECTOR",
          `请求 ${timestamp}s 超出${duration != null ? "视频解码时长" : "已知采样时间范围"}（0–${upper}s），请用 media_list_frames 查看可用帧`,
        );
    }
    const frame =
      timestamp === undefined
        ? frames.find((f) => f.id === frameId)
        : frames.reduce<(typeof frames)[number] | undefined>(
            (near, f) =>
              !near ||
              Math.abs(f.timestamp! - timestamp) <
                Math.abs(near.timestamp! - timestamp)
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
      label: { id: frame.id, page: frame.page, timestamp: frame.timestamp },
      image: {
        type: "image" as const,
        mimeType: "image/jpeg",
        data: bytes.toString("base64"),
      },
    };
  }
}
