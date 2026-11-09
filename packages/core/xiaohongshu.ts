import { z } from "zod";
import { LensError, mediaSchema, type Candidate } from "./contracts.js";
import { checked, fetchPublic, xhsNoteHost, xhsPath } from "./network.js";

const pageLimit = 4_000_000;
const unavailable = () =>
  new LensError(
    "XHS_NOTE_UNAVAILABLE",
    "访客页未提供该笔记的完整公开详情；未读取作品画面",
  );
const canonical = (id: string) => "https://www.xiaohongshu.com/explore/" + id;

export async function identifyXhs(source: string) {
  let url = new URL(source);
  if (!xhsPath.test(url.pathname)) {
    const result = await fetchPublic(
      source,
      "xhs-identify",
      AbortSignal.timeout(12000),
    );
    result.res.destroy();
    url = result.url;
  }
  const id = xhsPath.exec(url.pathname)?.[1];
  if (!id || !xhsNoteHost(url.hostname)) throw unavailable();
  return {
    platform: "xiaohongshu" as const,
    id,
    kind: "note",
    url: canonical(id),
  };
}

const rendition = z.object({
  masterUrl: z.string().optional(),
  format: z.string().optional(),
  duration: z.number().nonnegative().optional(),
});
const stream = z.object({ h264: z.array(rendition).optional() });
const noteSchema = z.object({
  noteId: z.string().optional(),
  id: z.string().optional(),
  type: z.enum(["normal", "video"]),
  title: z.string().max(12000).default(""),
  desc: z.string().max(12000).optional(),
  user: z.object({
    nickname: z.string().optional(),
    nickName: z.string().optional(),
  }),
  isPrivate: z.literal(false).optional(),
  isDeleted: z.literal(false).optional(),
  visibility: z.literal("public").optional(),
  needLogin: z.literal(false).optional(),
  video: z
    .object({ media: z.object({ stream: stream.optional() }).optional() })
    .nullish(),
  imageList: z
    .array(
      z.object({
        urlDefault: z.string().optional(),
        url: z.string().optional(),
        infoList: z
          .array(
            z.object({
              imageScene: z.string().optional(),
              url: z.string().optional(),
            }),
          )
          .optional(),
        livePhoto: z.boolean().optional(),
        stream: z
          .object({
            h264: z.array(z.unknown()).optional(),
            h265: z.array(z.unknown()).optional(),
          })
          .nullish(),
      }),
    )
    .max(120)
    .optional(),
});
function asset(raw: string, kind: "xhs-stream" | "xhs-photo") {
  // Preserve the rendition advertised to the guest, including its path and query.
  return checked(raw.replace(/^http:\/\//, "https://"), kind).href;
}
const detail = z.object({
  note: z
    .object({
      firstNoteId: z.string().optional(),
      noteDetailMap: z
        .record(z.string(), z.object({ note: z.unknown().optional() }).loose())
        .optional(),
    })
    .optional(),
  noteData: z
    .object({ data: z.object({ noteData: z.unknown().optional() }).nullish() })
    .nullish(),
});

export function parseXhsPage(html: string, id: string): Candidate {
  const title = /<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  if (
    /^\s*(?:小红书\s*[-|·]\s*)?(?:登录|sign in|log in)(?:\s*[-|·]\s*小红书)?\s*$/i.test(
      title,
    )
  )
    throw new LensError(
      "IDENTITY_LOGIN_REQUIRED",
      "小红书返回登录页；访客未读到作品",
    );
  if (/^\s*(?:小红书\s*[-|·]\s*)?(?:安全验证|访问验证|captcha)/i.test(title))
    throw new LensError("UPSTREAM_RISK_CONTROL", "小红书返回验证页；已停止");
  const match =
    /<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script\s*>/i.exec(
      html,
    );
  if (!match) throw unavailable();
  // Whitelist inert SSR placeholders outside strings. Never evaluate JavaScript.
  const json = match[1]
    .trim()
    .replace(/;$/, "")
    .replace(
      /"(?:[^"\\]|\\.)*"|\b(?:undefined|new (?:Map|Set)\(\[\]\))(?=\s*[,}\]])/g,
      (token) => (token.startsWith('"') ? token : "null"),
    );
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw unavailable();
  }
  const state = detail.safeParse(raw);
  if (!state.success) throw unavailable();
  const desktop = state.data.note;
  if (desktop?.firstNoteId && desktop.firstNoteId !== id) throw unavailable();
  const data = desktop?.noteDetailMap
    ? desktop.noteDetailMap[id]?.note
    : state.data.noteData?.data?.noteData;
  const parsed = noteSchema.safeParse(data);
  if (!parsed.success) throw unavailable();
  const n = parsed.data;
  if ((n.noteId ?? n.id) !== id || (n.id && n.id !== id)) throw unavailable();
  const base = {
    platform: "xiaohongshu",
    id,
    sourceUrl: canonical(id),
    title: n.title,
    description: n.desc,
    author: n.user.nickname ?? n.user.nickName ?? "",
    downloadPermission: "unknown",
  };
  if (n.type === "video") {
    const selected = n.video?.media?.stream?.h264?.find(
      (r) =>
        r.masterUrl &&
        (r.format?.toLowerCase() === "mp4" ||
          (!r.format && /\.mp4(?:[?#]|$)/i.test(r.masterUrl))),
    );
    return {
      media: mediaSchema.parse({
        ...base,
        kind: "video",
        duration: selected?.duration ? selected.duration / 1000 : null,
        rendition: selected ? "public_playback" : undefined,
      }),
      stream: selected?.masterUrl
        ? asset(selected.masterUrl, "xhs-stream")
        : null,
    };
  }
  const images = n.imageList ?? [];
  // Only still albums are supported. Never present a motion page as fully inspected.
  if (
    images.some(
      (i) => i.livePhoto || i.stream?.h264?.length || i.stream?.h265?.length,
    )
  )
    throw new LensError(
      "UNSUPPORTED_MEDIA",
      "本次小红书适配仅支持视频和静态图文，实况笔记尚未支持",
    );
  const urls = images.map(
    (i) =>
      i.urlDefault ||
      i.url ||
      i.infoList?.find((v) => v.imageScene === "WB_DFT")?.url,
  );
  const slides =
    urls.length && urls.every((u): u is string => Boolean(u))
      ? urls.map((u) => ({ poster: asset(u, "xhs-photo") }))
      : undefined;
  return {
    media: mediaSchema.parse({
      ...base,
      kind: "image_album",
      duration: null,
      pages: slides?.map((_, i) => ({ page: i + 1, kind: "still" })),
    }),
    slides,
    stream: null,
  };
}

export async function resolveXhs(source: string): Promise<Candidate> {
  const { res, url } = await fetchPublic(
    source,
    "xhs-page",
    AbortSignal.timeout(18000),
  );
  try {
    const id = xhsPath.exec(url.pathname)?.[1];
    if (
      !id ||
      !xhsNoteHost(url.hostname) ||
      !/^text\/html(?:\s*;|$)/i.test(res.headers["content-type"] ?? "")
    )
      throw unavailable();
    if (Number(res.headers["content-length"]) > pageLimit)
      throw new LensError("PROVIDER_PROTOCOL", "小红书页面超出大小限制");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of res) {
      const b = Buffer.from(chunk);
      bytes += b.length;
      if (bytes > pageLimit)
        throw new LensError("PROVIDER_PROTOCOL", "小红书页面超出大小限制");
      chunks.push(b);
    }
    return parseXhsPage(Buffer.concat(chunks).toString("utf8"), id);
  } finally {
    res.destroy();
  }
}
