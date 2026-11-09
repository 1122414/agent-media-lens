import { z } from "zod";
export class LensError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function failure(err: unknown) {
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
export const mediaSchema = z.object({
  id: z.string().regex(/^\d{8,21}$/),
  platform: z.literal("douyin"),
  sourceUrl: z.url(),
  title: z.string().max(12000),
  author: z.string().max(512),
  duration: z.number().nonnegative().nullable(),
  kind: z.enum(["video", "image_album"]).optional(),
  pages: z
    .array(
      z.object({ page: z.int().positive(), kind: z.enum(["still", "live"]) }),
    )
    .max(120)
    .optional(),
  downloadPermission: z.enum(["allowed", "disabled", "unknown"]).optional(),
  rendition: z.enum(["platform_download", "public_playback"]).optional(),
});
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
export const workerSchema = z.object({
  duration: z.number().positive().nullable(),
  transcript: z.object({
    language: z.string().nullable(),
    text: z.string().max(500000),
    segments: z
      .array(
        z.object({
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
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
      }),
    )
    .max(120),
});
export type Evidence = z.infer<typeof workerSchema>;
