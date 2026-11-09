import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.js";
import { LensError, mediaSchema, type Provider } from "./contracts.js";
import { checked, fetchPublic, share } from "./network.js";
const envelope = z.object({
  success: z.boolean(),
  data: z.unknown(),
  error: z.object({ code: z.string() }).nullable().optional(),
});
const common = z.object({
  kind: z.string(),
  is_deleted: z.boolean(),
  is_private: z.boolean(),
});
const content = z.object({
  platform: z.literal("douyin"),
  content_id: z.string(),
  title: z.string(),
  author: z.object({ nickname: z.string() }),
  duration_ms: z.number().nullish(),
  media: z.object({ video: z.object({ url: z.string() }) }),
  raw: z.object({
    status: z.object({
      private_status: z.literal(0),
      is_prohibited: z.literal(false),
      is_delete: z.literal(false),
      allow_share: z.literal(true),
    }),
    video_control: z.object({
      allow_download: z.literal(true),
      prevent_download: z.literal(false).optional(),
    }),
  }),
});
export function normalize(data: unknown) {
  const base = common.parse(data);
  if (base.is_private || base.is_deleted)
    throw new LensError("ACCESS_DENIED", "作品私密或已删除");
  if (base.kind !== "video")
    throw new LensError("UNSUPPORTED_MEDIA", "该作品为非视频类型");
  const r = content.safeParse(data);
  if (!r.success)
    throw new LensError(
      "PUBLIC_DOWNLOAD_UNCONFIRMED",
      "未能确认作品公开且允许下载",
    );
  const v = r.data;
  return {
    media: mediaSchema.parse({
      id: v.content_id,
      platform: v.platform,
      sourceUrl: "https://www.douyin.com/video/" + v.content_id,
      title: v.title,
      author: v.author.nickname,
      duration: v.duration_ms == null ? null : v.duration_ms / 1000,
    }),
    stream: checked(v.media.video.url, "stream").href,
  };
}
async function payload(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new LensError("PROVIDER_PROTOCOL", "服务响应为空");
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > 2000000) {
      await reader.cancel();
      throw new LensError("PROVIDER_PROTOCOL", "服务响应超限");
    }
    chunks.push(value);
  }
  return envelope.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
export function evil(c: Config, request = fetch): Provider {
  return {
    name: "evil0ctal",
    async health() {
      try {
        const r = await request(new URL("/readyz", c.endpoint), {
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        });
        await r.body?.cancel();
        return r.ok;
      } catch {
        return false;
      }
    },
    async resolve(input) {
      const source = share(input);
      const key = process.env.EVIL0CTAL_API_KEY;
      if (!key)
        throw new LensError("PROVIDER_AUTH", "请在本机配置 EVIL0CTAL_API_KEY");
      const signal = AbortSignal.timeout(45000);
      const url = new URL("/api/v1/douyin/video", c.endpoint);
      url.search = new URLSearchParams({
        url: source,
        include_raw: "true",
        refresh: "true",
        wait: "1",
      }).toString();
      async function read(u: URL) {
        let response: Response;
        try {
          response = await request(u, {
            headers: { "X-API-Key": key! },
            redirect: "error",
            signal,
          });
        } catch {
          throw new LensError("PROVIDER_CONNECTION", "服务连接失败或超时");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new LensError(
            response.status === 401 || response.status === 403
              ? "PROVIDER_AUTH"
              : "PROVIDER_REFUSED",
            "服务拒绝请求，HTTP " + response.status,
          );
        }
        const body = await payload(response);
        if (!body.success)
          throw new LensError("PROVIDER_REFUSED", "服务未能读取该作品");
        return { status: response.status, data: body.data };
      }
      const initial = await read(url);
      if (initial.status === 200) return normalize(initial.data);
      const id = z.object({ task_id: z.uuid() }).parse(initial.data).task_id;
      for (let i = 0; i < 40; i++) {
        await delay(750, undefined, { signal });
        const r = await read(new URL("/api/v1/tasks/" + id, c.endpoint));
        const task = z
          .object({
            state: z.enum(["queued", "running", "done", "failed"]),
            data: z.unknown().optional(),
          })
          .parse(r.data);
        if (task.state === "done") return normalize(task.data);
        if (task.state === "failed")
          throw new LensError("PROVIDER_FAILED", "上游任务失败");
      }
      throw new LensError("PROVIDER_TIMEOUT", "上游任务超时");
    },
  };
}
export async function identify(input: string) {
  let url = new URL(share(input));
  if (url.hostname === "v.douyin.com") {
    const r = await fetchPublic(url.href, "page", AbortSignal.timeout(12000));
    r.res.destroy();
    url = r.url;
  }
  const match = url.pathname.match(
    /^\/(?:share\/)?(video|note|slides)\/(\d{8,21})\/?$/,
  );
  if (!match) throw new LensError("UNRESOLVED", "未能确认最终作品类型");
  return {
    id: match[2],
    kind: match[1],
    url: "https://www.douyin.com/" + match[1] + "/" + match[2],
  };
}
export const native: Provider = {
  name: "native",
  async health() {
    return true;
  },
  async resolve(input) {
    const r = await identify(input);
    throw new LensError(
      r.kind === "video" ? "NATIVE_UNSUPPORTED" : "UNSUPPORTED_MEDIA",
      r.kind === "video"
        ? "原生 Provider 可识别作品，尚不支持元数据和下载"
        : "该作品为图文类型",
    );
  },
};
export async function resolveMedia(
  c: Config,
  input: string,
  provider = c.provider,
) {
  const link = await identify(input);
  if (link.kind !== "video")
    throw new LensError("UNSUPPORTED_MEDIA", "该作品为图文类型");
  const selected = provider === "evil0ctal" ? evil(c) : native;
  try {
    const found = await selected.resolve(link.url);
    if (found.media.id !== link.id)
      throw new LensError("PROVIDER_PROTOCOL", "作品标识不匹配");
    return { ...found, provider: selected.name };
  } catch (e) {
    if (
      selected !== native &&
      c.fallback &&
      e instanceof LensError &&
      e.code === "PROVIDER_CONNECTION"
    )
      return { ...(await native.resolve(input)), provider: native.name };
    throw e;
  }
}
