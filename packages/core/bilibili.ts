import { z } from "zod";
import { LensError, mediaSchema, type Candidate } from "./contracts.js";
import { biliPath, checked } from "./network.js";

const detail = z.object({
  platform: z.literal("bilibili"),
  kind: z.literal("video"),
  content_id: z.string().regex(/^BV1[1-9A-HJ-NP-Za-km-z]{9}$/),
  title: z.string(),
  author: z.object({ nickname: z.string() }),
  is_private: z.literal(false),
  is_deleted: z.literal(false),
  parts: z
    .array(
      z.object({
        part: z.int().positive(),
        title: z.string(),
        duration_ms: z.number().nonnegative().nullable(),
      }),
    )
    .min(1),
  raw: z.object({
    bvid: z.string(),
    aid: z.number().int().positive(),
    state: z.literal(0),
    rights: z.object({
      no_share: z.literal(0),
      pay: z.literal(0),
      ugc_pay: z.literal(0),
      arc_pay: z.literal(0).optional(),
      ugc_pay_preview: z.literal(0).optional(),
      download: z.union([z.literal(0), z.literal(1)]).optional(),
    }),
    is_upower_exclusive: z.union([z.literal(false), z.literal(0)]).optional(),
    is_chargeable_season: z.union([z.literal(false), z.literal(0)]).optional(),
    __dtk_part: z.int().positive().optional(),
    __dtk_streams: z
      .object({
        format: z.string().optional(),
        timelength: z.number().nonnegative().nullish(),
        is_preview: z.union([z.literal(0), z.literal(false)]).optional(),
        durl: z
          .array(
            z.object({
              url: z.string(),
              backup_url: z.array(z.string()).nullish(),
            }),
          )
          .nullish(),
      })
      .nullish(),
  }),
});
/** Keep the selected part and use only the guest player's supplied media URLs. */
export function normalizeBilibili(data: unknown, source: string): Candidate {
  const parsed = detail.safeParse(data);
  if (!parsed.success)
    throw new LensError(
      "PUBLIC_VIDEO_UNCONFIRMED",
      "无法确认 B 站稿件为公开、完整且无需付费的作品",
    );
  const v = parsed.data,
    input = new URL(source);
  const id = biliPath.exec(input.pathname)?.[1];
  if (
    v.raw.bvid !== v.content_id ||
    !(id === v.content_id || id === "av" + v.raw.aid)
  )
    throw new LensError("PROVIDER_PROTOCOL", "B 站作品标识不匹配");
  const n = Number(input.searchParams.get("p") ?? 1),
    part = v.parts.find((p) => p.part === n);
  if (!part || (v.raw.__dtk_part ?? 1) !== n)
    throw new LensError(
      "INVALID_PART",
      "找不到请求的 B 站分 P 或上游返回了其他分 P",
    );
  const play = v.raw.__dtk_streams;
  let stream: string | null = null;
  // The detail's part duration is rounded to seconds. A materially shorter
  // player response cannot supply evidence for the complete part.
  const shortened =
    play?.timelength != null &&
    part.duration_ms != null &&
    play.timelength + 2000 < part.duration_ms;
  if (
    !shortened &&
    play?.format?.startsWith("mp4") &&
    play.durl?.length === 1
  ) {
    const file = play.durl[0];
    for (const address of [file.url, ...(file.backup_url ?? [])]) {
      try {
        const candidate = new URL(address);
        if (candidate.protocol === "http:") candidate.protocol = "https:";
        stream = checked(candidate.href, "bili-stream").href;
        break;
      } catch {
        /* Another platform-supplied mirror may satisfy the HTTPS policy. */
      }
    }
    if (!stream)
      throw new LensError("UNSAFE_URL", "B 站未提供可验证的媒体地址");
  }
  return {
    stream,
    media: mediaSchema.parse({
      id: v.content_id,
      platform: "bilibili",
      kind: "video",
      title: v.title,
      author: v.author.nickname,
      sourceUrl:
        "https://www.bilibili.com/video/" +
        v.content_id +
        "/" +
        (n > 1 ? "?p=" + n : ""),
      duration: part.duration_ms === null ? null : part.duration_ms / 1000,
      part: { number: n, total: v.parts.length, title: part.title },
      downloadPermission:
        v.raw.rights.download === 1
          ? "allowed"
          : v.raw.rights.download === 0
            ? "disabled"
            : "unknown",
      rendition: stream ? "public_playback" : undefined,
    }),
  };
}
