import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  douyinLogin,
  loginNeeded,
  providerKey,
  type Config,
} from "./config.js";
import { LensError, mediaSchema, type Provider } from "./contracts.js";
import { normalizeBilibili } from "./bilibili.js";
import { biliPath, checked, fetchPublic, share, xhsPage } from "./network.js";
import { identifyXhs, resolveXhs } from "./xiaohongshu.js";
const providerError = z.object({ code: z.string() });
const resultMeta = z
  .object({
    guest_fallback: z.boolean().optional(),
    identity_id: z.string().nullish(),
    cached: z.boolean().optional(),
  })
  .nullish();
const envelope = z.object({
  success: z.boolean(),
  data: z.unknown(),
  error: providerError.nullish(),
  meta: resultMeta,
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
  media: z.object({
    video: z.object({ url: z.string() }).nullish(),
    images: z.unknown().optional(),
  }),
  raw: z.object({
    status: z.object({
      private_status: z.literal(0),
      is_prohibited: z.literal(false),
      is_delete: z.literal(false),
      allow_share: z.literal(true),
    }),
    video: z
      .object({
        download_addr: z.object({ url_list: z.array(z.string()) }).nullish(),
      })
      .optional(),
    video_control: z
      .object({
        allow_download: z.unknown().optional(),
        prevent_download: z.unknown().optional(),
      })
      .nullish(),
  }),
});
export function normalize(
  data: unknown,
  source?: string,
): import("./contracts.js").Candidate {
  const base = common.parse(data);
  if (base.is_private || base.is_deleted)
    throw new LensError("ACCESS_DENIED", "作品私密或已删除");
  if (base.kind !== "video" && base.kind !== "image_album")
    throw new LensError("UNSUPPORTED_MEDIA", "该作品为非视频类型");
  const r = content.safeParse(data);
  if (!r.success)
    throw new LensError(
      "PUBLIC_DOWNLOAD_UNCONFIRMED",
      "未能确认公开状态或读取有效的作品详情",
    );
  const v = r.data;
  const flags = v.raw.video_control;
  const permission =
    flags?.allow_download === false || flags?.prevent_download === true
      ? "disabled"
      : flags?.allow_download === true &&
          (flags.prevent_download === undefined ||
            flags.prevent_download === false)
        ? "allowed"
        : "unknown";
  if (base.kind === "image_album") {
    const images = z
      .array(
        z.object({
          url: z.string(),
          video: z.object({ url: z.string() }).nullish(),
        }),
      )
      .min(1)
      .max(120)
      .parse(v.media.images);
    const slides = images.map((image) => ({
      poster: checked(image.url, "photo").href,
      clip: image.video ? checked(image.video.url, "stream").href : undefined,
    }));
    return {
      media: mediaSchema.parse({
        id: v.content_id,
        platform: v.platform,
        kind: "image_album",
        sourceUrl: source ?? "https://www.douyin.com/note/" + v.content_id,
        title: v.title,
        author: v.author.nickname,
        duration: null,
        downloadPermission: permission,
        pages: slides.map((slide, index) => ({
          page: index + 1,
          kind: slide.clip ? "live" : "still",
        })),
      }),
      slides,
      stream: null,
    };
  }
  const playback = v.media.video?.url;
  const download =
    permission === "allowed" && v.raw.video?.download_addr?.url_list[0];
  const selected = download || playback;
  return {
    media: mediaSchema.parse({
      id: v.content_id,
      platform: v.platform,
      sourceUrl: "https://www.douyin.com/video/" + v.content_id,
      title: v.title,
      author: v.author.nickname,
      downloadPermission: permission,
      rendition: download
        ? "platform_download"
        : playback
          ? "public_playback"
          : undefined,
      duration: v.duration_ms == null ? null : v.duration_ms / 1000,
    }),
    stream: selected ? checked(selected, "stream").href : null,
  };
}
async function payload(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new LensError("PROVIDER_PROTOCOL", "服务响应为空");
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel();
      throw new LensError("PROVIDER_PROTOCOL", "服务响应超限");
    }
    chunks.push(value);
  }
  return envelope.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
const publicErrors = new Map([
  ["IDENTITY_POOL_EXHAUSTED", "采集服务没有可调度的平台身份"],
  ["IDENTITY_LOGIN_REQUIRED", "作品需要登录；已停止访客采集"],
  ["UPSTREAM_RISK_CONTROL", "平台限制了本次访问；已停止采集"],
  ["CONTENT_PRIVATE", "作品非公开；已停止采集"],
  ["MEDIA_WITHHELD", "平台未提供可下载的媒体"],
  ["RATE_LIMITED", "服务或平台限流，请稍后再试"],
  ["INVALID_PARAM", "上游拒绝作品或分 P 参数"],
  ["NOT_FOUND", "未找到请求的资源"],
  ["UPSTREAM_UNREACHABLE", "采集服务无法连接平台"],
]);
function providerFailure(code: string | undefined, fallback: LensError) {
  const message = code && publicErrors.get(code);
  return code && message ? new LensError(code, message) : fallback;
}
async function readProvider(
  url: URL,
  key: string,
  signal: AbortSignal,
  request: typeof fetch,
  limit = 2_000_000,
) {
  let response: Response;
  try {
    response = await request(url, {
      headers: { "X-API-Key": key },
      redirect: "error",
      signal,
    });
  } catch {
    throw new LensError("PROVIDER_CONNECTION", "服务连接失败或超时");
  }
  const refused = new LensError(
    response.status === 401 || response.status === 403
      ? "PROVIDER_AUTH"
      : "PROVIDER_REFUSED",
    "服务拒绝请求，HTTP " + response.status,
  );
  let body;
  try {
    body = await payload(response, limit);
  } catch {
    if (!response.ok) throw refused;
    throw new LensError("PROVIDER_PROTOCOL", "无法读取服务响应");
  }
  if (!response.ok || !body.success)
    throw providerFailure(
      body.error?.code,
      response.ok
        ? new LensError("PROVIDER_REFUSED", "服务未能处理请求")
        : refused,
    );
  return {
    status: response.status,
    data: body.data,
    meta: body.meta,
  };
}
async function ready(c: Config, request: typeof fetch) {
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
}
export async function inspectEvil(
  c: Config,
  request = fetch,
  platform: "douyin" | "bilibili" = "douyin",
) {
  const serviceReady = await ready(c, request);
  const key = providerKey(c);
  if (!serviceReady) return { serviceReady, code: "PROVIDER_CONNECTION" };
  if (!key) return { serviceReady, code: "PROVIDER_KEY_MISSING" };
  const read = (path: string) =>
    readProvider(
      new URL(path, c.endpoint),
      key,
      AbortSignal.timeout(5000),
      request,
    );
  try {
    const me = z
      .object({
        user: z.object({
          via: z.literal("api_key"),
          scopes: z.array(z.string()),
        }),
      })
      .parse((await read("/api/v1/auth/me")).data);
    if (!me.user.scopes.some((s) => s === platform + ":read" || s === "admin"))
      return { serviceReady, code: "PROVIDER_SCOPE" };
    const count = z.int().nonnegative();
    const status = z
      .object({
        pool: z.object({ [platform]: z.object({ active: count }) }),
        reserved_active: z.object({ [platform]: count }),
      })
      .parse((await read("/api/v1/system/status")).data);
    const available = Math.max(
      0,
      status.pool[platform].active - status.reserved_active[platform],
    );
    return {
      serviceReady,
      code: available ? "OK" : "IDENTITY_POOL_EXHAUSTED",
      available,
    };
  } catch (error) {
    return {
      serviceReady,
      code: error instanceof LensError ? error.code : "PROVIDER_PROTOCOL",
    };
  }
}
export async function queryProviderResult(
  c: Config,
  platform: "douyin" | "bilibili",
  operation: "video" | "user/posts" | "user/mixes" | "mix/posts",
  params: Record<string, string>,
  request = fetch,
  auth: "guest" | "local-login" = "guest",
) {
  if (
    auth === "local-login" &&
    (platform !== "douyin" || operation !== "user/posts")
  )
    throw new LensError(
      "LOCAL_LOGIN_SCOPE",
      "本机登录仅用于抖音作者的公开投稿",
    );
  if (auth === "local-login")
    z.strictObject({
      sec_user_id: z.string().regex(/^MS4wLj[A-Za-z0-9_-]{10,180}$/),
      count: z
        .string()
        .regex(/^(?:[1-9]|1[0-9]|20)$/)
        .optional(),
      cursor: z
        .string()
        .regex(/^\d{1,24}$/)
        .optional(),
    }).parse(params);
  const login = auth === "local-login" ? douyinLogin(c) : undefined;
  const key = login?.apiKey ?? providerKey(c);
  if (!key)
    throw new LensError("PROVIDER_AUTH", "请在本机配置 EVIL0CTAL_API_KEY");
  const signal = AbortSignal.timeout(45000);
  const url = new URL("/api/v1/" + platform + "/" + operation, c.endpoint);
  url.search = new URLSearchParams({
    ...params,
    ...(login && { identity: login.identityId, include_raw: "true" }),
    wait: "1",
  }).toString();
  const read = (u: URL) =>
    readProvider(u, key, signal, request, login ? 8_000_000 : undefined);
  if (login) {
    const inventory = new URL("/api/v1/admin/identities", c.endpoint);
    inventory.search = new URLSearchParams({
      platform: "douyin",
      identity_id: login.identityId,
      authenticated: "true",
      rotation: "reserved",
      limit: "1",
    }).toString();
    const records = z
      .array(
        z.object({
          id: z.uuid(),
          platform: z.string(),
          authenticated: z.boolean(),
          state: z.string(),
          rotation_endpoints: z.array(z.string()).nullable(),
          expires_at: z.iso.datetime({ offset: true }).nullable(),
          cooldown_until: z.iso.datetime({ offset: true }).nullable(),
          session: z.object({ verdict: z.string() }),
        }),
      )
      .parse((await read(inventory)).data);
    const row = records[0];
    if (
      !row ||
      row.id !== login.identityId ||
      row.platform !== "douyin" ||
      !row.authenticated ||
      row.rotation_endpoints?.length !== 0 ||
      row.state === "retired" ||
      row.session.verdict !== "ok" ||
      (row.expires_at && Date.parse(row.expires_at) <= Date.now())
    )
      throw loginNeeded();
    if (
      (row.state === "cooling" || row.state === "degraded") &&
      row.cooldown_until &&
      Date.parse(row.cooldown_until) > Date.now()
    )
      throw new LensError(
        "LOCAL_LOGIN_COOLING",
        "本机登录身份正在冷却，稍后再试",
      );
  }
  const finish = (data: unknown, meta: z.infer<typeof resultMeta>) => {
    if (
      login &&
      (meta?.identity_id !== login.identityId ||
        meta?.cached !== false ||
        meta?.guest_fallback === true)
    )
      throw new LensError(
        "LOCAL_LOGIN_UNCONFIRMED",
        "服务未确认所选登录身份的实时响应",
      );
    return { data, guestFallback: meta?.guest_fallback === true };
  };
  const checkedRead = async (u: URL) => {
    try {
      return await read(u);
    } catch (e) {
      if (
        login &&
        e instanceof LensError &&
        e.code === "IDENTITY_LOGIN_REQUIRED"
      )
        throw loginNeeded();
      throw e;
    }
  };
  const initial = await checkedRead(url);
  if (initial.status === 200) return finish(initial.data, initial.meta);
  const id = z.object({ task_id: z.uuid() }).parse(initial.data).task_id;
  for (let i = 0; i < 40; i++) {
    await delay(750, undefined, { signal });
    const r = await checkedRead(new URL("/api/v1/tasks/" + id, c.endpoint));
    const task = z
      .object({
        state: z.enum(["queued", "running", "done", "failed"]),
        data: z.unknown().optional(),
        error: providerError.nullish(),
        result_meta: resultMeta,
      })
      .parse(r.data);
    if (task.state === "done") return finish(task.data, task.result_meta);
    if (
      login &&
      task.state === "failed" &&
      task.error?.code === "IDENTITY_LOGIN_REQUIRED"
    )
      throw loginNeeded();
    if (task.state === "failed")
      throw providerFailure(
        task.error?.code,
        new LensError("PROVIDER_FAILED", "上游任务失败"),
      );
  }
  throw new LensError("PROVIDER_TIMEOUT", "上游任务超时");
}
export async function queryProvider(
  ...args: Parameters<typeof queryProviderResult>
) {
  return (await queryProviderResult(...args)).data;
}
export function evil(c: Config, request = fetch): Provider {
  return {
    name: "evil0ctal",
    health: () => ready(c, request),
    async resolve(input) {
      const source = share(input);
      if (xhsPage(new URL(source).hostname))
        throw new LensError("UNSUPPORTED", "小红书分享仅由原生访客适配器读取");
      const platform =
        new URL(source).hostname === "www.bilibili.com" ? "bilibili" : "douyin";
      const normalizeResult =
        platform === "bilibili" ? normalizeBilibili : normalize;
      const data = await queryProvider(
        c,
        platform,
        "video",
        { url: source, include_raw: "true", refresh: "true" },
        request,
      );
      return normalizeResult(data, source);
    },
  };
}
export async function identify(input: string) {
  let url = new URL(share(input));
  if (xhsPage(url.hostname)) return identifyXhs(url.href);
  if (url.hostname === "b23.tv") {
    const requested = url.searchParams.get("p");
    const r = await fetchPublic(
      url.href,
      "bili-page",
      AbortSignal.timeout(12000),
    );
    r.res.destroy();
    url = new URL(share(r.url.href));
    if (requested) url.searchParams.set("p", requested);
  }
  if (url.hostname === "www.bilibili.com") {
    const id = biliPath.exec(url.pathname)?.[1];
    if (!id) throw new LensError("UNRESOLVED", "未能识别 B 站稿件");
    return { id, kind: "video", url: url.href, platform: "bilibili" as const };
  }
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
    platform: "douyin" as const,
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
    const source = share(input);
    if (xhsPage(new URL(source).hostname)) return resolveXhs(source);
    await identify(source);
    throw new LensError(
      "NATIVE_UNSUPPORTED",
      "原生 Provider 可识别作品链接，读取作品详情与媒体需要 Evil0ctal",
    );
  },
};
export async function resolveMedia(
  c: Config,
  input: string,
  provider = c.provider,
) {
  const source = share(input);
  if (xhsPage(new URL(source).hostname))
    return { ...(await native.resolve(source)), provider: native.name };
  const link = await identify(source);
  const selected = provider === "evil0ctal" ? evil(c) : native;
  try {
    const found = await selected.resolve(link.url);
    if (
      found.media.platform !== link.platform ||
      (link.platform === "douyin" && found.media.id !== link.id)
    )
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
