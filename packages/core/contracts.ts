import { z } from "zod";
export class LensError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class PublicHttpError extends LensError {
  constructor(
    code: string,
    message: string,
    readonly httpStatus: number,
    readonly hostname: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      code,
      `${hostname} HTTP ${httpStatus}：${message}${retryAfterSeconds === undefined ? "" : `（Retry-After: ${retryAfterSeconds}s）`}`,
    );
  }
}
export function durationLimit(seconds: number, limit: number) {
  return new LensError(
    "DURATION_LIMIT",
    `时长 ${seconds.toFixed(1)}s 超出上限 ${limit}s；可在 MEDIA_LENS_CONFIG 指定的 JSON 中调整 maxSeconds（最高 3600s）`,
  );
}
export function failure(err: unknown) {
  if (err instanceof PublicHttpError)
    return {
      code: err.code,
      message: err.message,
      httpStatus: err.httpStatus,
      hostname: err.hostname,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  if (err instanceof LensError) return { code: err.code, message: err.message };
  if (err instanceof z.ZodError)
    return {
      code: "INVALID_DATA",
      message: "输入或外部服务的数据格式不符合约定",
    };
  return {
    code: "IO_ERROR",
    message: "操作失败，请检查服务、文件权限和运行环境",
  };
}
export const mediaSchema = z
  .object({
    id: z
      .string()
      .regex(/^(?:\d{8,21}|BV1[1-9A-HJ-NP-Za-km-z]{9}|[a-f0-9]{24})$/),
    platform: z.enum(["douyin", "bilibili", "xiaohongshu"]),
    sourceUrl: z.url(),
    title: z.string().max(12000),
    author: z.string().max(512),
    description: z.string().max(12000).optional(),
    duration: z.number().nonnegative().nullable(),
    kind: z.enum(["video", "image_album"]).optional(),
    part: z
      .object({
        number: z.int().positive(),
        total: z.int().positive(),
        title: z.string(),
      })
      .optional(),
    pages: z
      .array(
        z.object({ page: z.int().positive(), kind: z.enum(["still", "live"]) }),
      )
      .max(120)
      .optional(),
    downloadPermission: z.enum(["allowed", "disabled", "unknown"]).optional(),
    rendition: z.enum(["platform_download", "public_playback"]).optional(),
  })
  .refine(
    (m) =>
      m.platform === "xiaohongshu"
        ? /^[a-f0-9]{24}$/.test(m.id)
        : m.id.length !== 24,
    { message: "作品编号与平台不符" },
  );
export type Media = z.infer<typeof mediaSchema>;
export interface Candidate {
  media: Media;
  slides?: { poster: string; clip?: string }[];
  stream: string | null;
}
export interface Provider {
  name: string;
  resolve(url: string): Promise<Candidate>;
  health(): Promise<boolean>;
}
export const stages = [
  "PENDING",
  "RESOLVING",
  "DOWNLOADING",
  "EXTRACTING_AUDIO",
  "TRANSCRIBING",
  "EXTRACTING_FRAMES",
  "OCR",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type Stage = (typeof stages)[number];
const warning = z.enum(["MODEL_UNAVAILABLE", "MODEL_FALLBACK", "ASR_FAILED"]);
export const workerSchema = z.object({
  duration: z.number().positive().nullable(),
  warnings: z.array(warning).optional(),
  processing: z
    .object({
      requestedModel: z.string(),
      requestedDevice: z.string(),
      asrFallback: z.boolean(),
      promptConfigured: z.boolean(),
      maxFrames: z.int(),
      maxSeconds: z.int(),
      interval: z.number(),
      ocrLang: z.string(),
      beamSize: z.int(),
      vadFilter: z.boolean(),
    })
    .optional(),
  transcript: z.object({
    status: z
      .enum(["ok", "no_audio", "no_speech", "not_applicable", "unavailable"])
      .optional(),
    warning: warning.optional(),
    model: z.string().optional(),
    device: z.string().optional(),
    computeType: z.string().optional(),
    language: z.string().nullable(),
    text: z.string().max(500000),
    segments: z
      .array(
        z.object({
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          avgLogprob: z.number().optional(),
          noSpeechProb: z.number().optional(),
          lowConfidence: z.boolean().optional(),
          text: z.string(),
        }),
      )
      .max(10000),
  }),
  frames: z
    .array(
      z.object({
        id: z.string().regex(/^f\d{3}$/),
        timestamp: z.number().nonnegative().nullable(),
        page: z.int().positive().optional(),
        role: z.literal("possible_platform_outro").optional(),
        imagePath: z.string().regex(/^f\d{3}\.jpg$/),
      }),
    )
    .max(120),
  ocr: z
    .array(
      z.object({
        frameId: z.string(),
        timestamp: z.number().nonnegative().nullable(),
        page: z.int().positive().optional(),
        text: z.string().max(16000),
        rawText: z.string().max(16000).optional(),
        foldedLines: z
          .object({
            possibleOverlay: z.int().nonnegative(),
            shortUncertain: z.int().nonnegative(),
          })
          .optional(),
        confidence: z.number().min(0).max(100).nullable().optional(),
        repeatedOf: z
          .string()
          .regex(/^f\d{3}$/)
          .optional(),
      }),
    )
    .max(120),
});
export type Evidence = z.infer<typeof workerSchema>;
