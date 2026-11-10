import { lookup } from "node:dns/promises";
import { get } from "node:https";

import { open, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ipaddr from "ipaddr.js";
import { setTimeout as sleep } from "node:timers/promises";
import { trace } from "./diagnostics.js";
import { LensError, PublicHttpError } from "./contracts.js";
const pages = [
  "www.douyin.com",
  "douyin.com",
  "v.douyin.com",
  "www.iesdouyin.com",
  "www.douyin.com.cn",
];
const cdns = ["douyinvod.com", "zjcdn.com", "douyin.com", "amemv.com"];
const biliPages = [
  "www.bilibili.com",
  "m.bilibili.com",
  "bilibili.com",
  "b23.tv",
];
export const biliPath =
  /^\/video\/(BV1[1-9A-HJ-NP-Za-km-z]{9}|av[1-9]\d{0,15})\/?$/;
export const xhsPath = /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/;
const xhsShort = ["xhslink.cn", "xhslink.com"];
export const xhsNoteHost = (host: string) =>
  ["www.xiaohongshu.com", "xiaohongshu.com"].includes(host);
export const xhsPage = (host: string) =>
  xhsShort.includes(host) || xhsNoteHost(host);
export type AssetKind =
  "stream" | "bili-stream" | "photo" | "xhs-photo" | "xhs-stream";
type UrlKind =
  | "bili-profile"
  | "dy-profile"
  | "page"
  | "bili-page"
  | "xhs-page"
  | "xhs-identify"
  | AssetKind;
function allowedHost(host: string, kind: UrlKind, redirectedFrom?: URL) {
  switch (kind) {
    case "xhs-page":
    case "xhs-identify":
      return xhsPage(host);
    case "xhs-photo":
      return /^sns-(?:webpic|img)(?:-[a-z0-9]+)?\.xhscdn\.com$/.test(host);
    case "xhs-stream":
      return /^sns-video(?:-[a-z0-9]+)?\.xhscdn\.(?:com|net)$/.test(host);
    case "bili-profile":
      return biliPages.includes(host) || host === "space.bilibili.com";
    case "dy-profile":
      return pages.includes(host);
    case "page":
      return pages.includes(host);
    case "bili-page":
      return biliPages.includes(host);
    case "photo":
      return /^p[0-9]+-(?:pc-)?sign\.douyinpic\.com$/.test(host);
    case "bili-stream":
      return (
        host.endsWith(".bilivideo.com") ||
        host.endsWith(".bilivideo.cn") ||
        host === "upos-hz-mirrorakam.akamaized.net"
      );
    case "stream":
      return (
        cdns.some((d) => host === d || host.endsWith("." + d)) ||
        (redirectedFrom?.protocol === "https:" &&
          redirectedFrom.hostname.endsWith(".douyinvod.com") &&
          /^[0-9a-f]{32}\.v\.smtcdns\.com$/.test(host))
      );
  }
}
export function checked(input: string, kind: UrlKind, redirectedFrom?: URL) {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new LensError("INVALID_URL", "链接格式无效");
  }
  const host = u.hostname;
  const allowed = allowedHost(host, kind, redirectedFrom);
  if (
    !allowed ||
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    input.length > 4096
  )
    throw new LensError("UNSAFE_URL", "仅支持允许域名的 HTTPS 链接");
  return u;
}
export function share(input: string) {
  const found = input.match(/https?:\/\/[^\s，。；<>]+/g);
  if (found?.length !== 1)
    throw new LensError(
      "INVALID_URL",
      "请输入一个抖音、哔哩哔哩或小红书作品链接",
    );
  if (URL.canParse(found[0]) && xhsPage(new URL(found[0]).hostname)) {
    const raw = new URL(found[0]);
    const short = xhsShort.includes(raw.hostname);
    if (short && raw.protocol === "http:" && !raw.port) raw.protocol = "https:";
    const u = checked(raw.href, "xhs-page");
    if (
      !(short
        ? /^\/(?:[a-z]\/)?[A-Za-z0-9_-]{3,64}\/?$/.test(u.pathname)
        : xhsPath.test(u.pathname))
    )
      throw new LensError("UNSUPPORTED", "仅支持小红书单篇公开笔记的分享链接");
    u.hash = "";
    return u.href;
  }
  if (
    URL.canParse(found[0]) &&
    biliPages.includes(new URL(found[0]).hostname)
  ) {
    const u = checked(found[0], "bili-page");
    const short = u.hostname === "b23.tv";
    if (
      !(short
        ? /^\/[a-zA-Z0-9]+\/?$/.test(u.pathname)
        : biliPath.test(u.pathname))
    )
      throw new LensError("UNSUPPORTED", "仅支持 B 站公开视频稿件");
    const parts = u.searchParams.getAll("p");
    if (
      parts.length > 1 ||
      (parts.length === 1 && !/^[1-9]\d{0,3}$/.test(parts[0]))
    )
      throw new LensError("INVALID_PART", "B 站分 P 参数无效");
    u.search = "";
    u.hash = "";
    if (parts.length) u.searchParams.set("p", parts[0]);
    if (!short) u.hostname = "www.bilibili.com";
    return u.href;
  }
  const u = checked(found[0], "page");
  if (
    !(
      u.hostname === "v.douyin.com"
        ? /^\/[\w-]+\/?$/
        : /^\/(?:share\/)?(?:video|note|slides)\/\d{8,21}\/?$/
    ).test(u.pathname)
  )
    throw new LensError("UNSUPPORTED", "仅支持抖音视频或作品分享页");
  u.hash = "";
  u.search = "";
  return u.href;
}
export function checkXhsGate(url: URL, status?: number) {
  if (
    /^\/(?:website-login|login)(?:\/|$)/i.test(url.pathname) ||
    status === 401
  )
    throw new LensError(
      "IDENTITY_LOGIN_REQUIRED",
      "小红书要求登录；访客未读到作品。请勿向 Agent 提供 Cookie",
    );
  if (
    /^\/(?:website-security|captcha|verify|challenge)(?:\/|$)/i.test(
      url.pathname,
    ) ||
    status === 403 ||
    status === 461 ||
    status === 471
  )
    throw new LensError(
      "UPSTREAM_RISK_CONTROL",
      "小红书拒绝本次访问或要求验证；已停止",
    );
  if (status === 429) throw new LensError("RATE_LIMITED", "小红书限流；已停止");
  if (
    /^\/(?:404|undertake_note_error)(?:\/|$)/i.test(url.pathname) ||
    status === 404 ||
    status === 410
  )
    throw new LensError(
      "XHS_SHARE_UNAVAILABLE",
      "这条小红书分享当前不可读；无法据此确认笔记已删除",
    );
}
function retryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return Math.min(Number(raw), Number.MAX_SAFE_INTEGER);
  // Do not let Date.parse reinterpret a signed number as a calendar date.
  if (!/[a-z]/i.test(raw)) return undefined;
  const time = Date.parse(raw);
  return Number.isFinite(time)
    ? Math.max(0, Math.ceil((time - Date.now()) / 1000))
    : undefined;
}

export async function retryPublicRead<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  onRetry?: () => void,
  retryTransport = false,
): Promise<T> {
  for (let retries = 0; ; retries++) {
    signal.throwIfAborted();
    try {
      return await run();
    } catch (err) {
      const http = err instanceof PublicHttpError ? err : undefined;
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      const transient = http
        ? http.code === "HTTP_RATE_LIMITED" ||
          (http.code === "HTTP_SERVER_ERROR" &&
            [500, 502, 503, 504].includes(http.httpStatus))
        : retryTransport &&
          ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
      if (!transient || retries >= (http ? 2 : 1) || signal.aborted) throw err;
      const delayMs = Math.max(
        2000 * 2 ** retries,
        (http?.retryAfterSeconds ?? 0) * 1000,
      );
      // Never shorten a server-requested delay to fit our local wait budget.
      if (delayMs > 8000) throw err;
      trace({
        event: "retry",
        code,
        hostname: http?.hostname,
        httpStatus: http?.httpStatus,
        attempt: retries + 2,
        delayMs,
      });
      try {
        await sleep(delayMs, undefined, { signal });
      } catch {
        if (http && signal.reason?.name === "TimeoutError") throw http;
        throw signal.reason;
      }
      signal.throwIfAborted();
      onRetry?.();
    }
  }
}

export function fetchPublic(
  input: string,
  kind: UrlKind,
  signal: AbortSignal,
  onRetry?: () => void,
) {
  return retryPublicRead(
    () => requestPublicOnce(input, kind, signal),
    signal,
    onRetry,
  );
}
async function requestPublicOnce(
  input: string,
  kind: UrlKind,
  signal: AbortSignal,
) {
  let url = checked(input, kind);
  const xhs = kind === "xhs-page" || kind === "xhs-identify";
  let expectedNote = xhs ? xhsPath.exec(url.pathname)?.[1] : undefined;
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const started = performance.now();
    const ips = await lookup(url.hostname, { all: true, family: 4 });
    if (
      !ips.length ||
      ips.some((ip) => ipaddr.parse(ip.address).range() !== "unicast")
    )
      throw new LensError("UNSAFE_URL", "目标 IP 不在公网范围内");
    const address = ips[0].address;
    const res = await new Promise<import("node:http").IncomingMessage>(
      (ok, fail) => {
        const req = get(
          url,
          {
            signal,
            agent: false,
            family: 4,
            lookup: (_h, _o, cb) => cb(null, address, 4),
            headers: {
              "user-agent": "Mozilla/5.0 AgentMediaLens/0.3",
              ...(kind === "bili-stream"
                ? { referer: "https://www.bilibili.com/" }
                : {}),
            },
          },
          ok,
        );
        req.once("error", fail);
      },
    );
    trace({
      event: "http",
      hostname: url.hostname,
      status: res.statusCode ?? 0,
      hop,
      elapsedMs: Math.round(performance.now() - started),
    });
    if (
      [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
      res.headers.location
    ) {
      res.destroy();
      const next = new URL(res.headers.location, url);
      // Some official short links advertise an HTTP location. Never request it in plaintext.
      if (xhs && next.protocol === "http:" && !next.port)
        next.protocol = "https:";
      const previous = url.hostname;
      url = checked(next.href, kind, url);
      trace({
        event: "redirect",
        fromHost: previous,
        toHost: url.hostname,
        hop: hop + 1,
      });
      if (xhs) {
        checkXhsGate(url);
        const note = xhsPath.exec(url.pathname)?.[1];
        if (note && !xhsShort.includes(url.hostname)) {
          if (expectedNote && note !== expectedNote)
            throw new LensError("PROVIDER_PROTOCOL", "小红书跳转到了其他笔记");
          expectedNote = note;
          if (kind === "xhs-identify") return { res, url };
        } else if (
          !xhsShort.includes(url.hostname) &&
          !["/", "/explore"].includes(url.pathname)
        ) {
          throw new LensError("UNRESOLVED", "分享未指向可识别的小红书笔记");
        }
      }
      if (
        (kind === "bili-profile" &&
          ["space.bilibili.com", "m.bilibili.com"].includes(url.hostname)) ||
        (kind === "dy-profile" && /^\/(?:share\/)?user\//.test(url.pathname)) ||
        (kind === "bili-page" &&
          url.hostname !== "b23.tv" &&
          biliPath.test(url.pathname)) ||
        (kind === "page" &&
          /^\/(?:share\/)?(?:video|note|slides)\/\d{8,21}\/?$/.test(
            url.pathname,
          ))
      )
        return { res, url };
      continue;
    }
    if (res.statusCode !== 200) {
      res.destroy();
      const status = res.statusCode ?? 0;
      const after = retryAfter(res.headers["retry-after"]);
      if (xhs || kind === "xhs-photo" || kind === "xhs-stream") {
        try {
          checkXhsGate(url, status);
        } catch (gate) {
          if (gate instanceof LensError)
            throw new PublicHttpError(
              gate.code,
              gate.message,
              status,
              url.hostname,
              after,
            );
          throw gate;
        }
        throw new PublicHttpError(
          "UNAVAILABLE",
          "访客请求失败；已停止",
          status,
          url.hostname,
          after,
        );
      }
      const [code, message] =
        status === 429
          ? ["HTTP_RATE_LIMITED", "请求受限，请稍后再试"]
          : status === 403 || status === 401
            ? ["HTTP_ACCESS_DENIED", "资源拒绝访问；已停止"]
            : status === 404 || status === 410
              ? ["HTTP_NOT_FOUND", "资源不存在或已失效"]
              : status >= 500 && status < 600
                ? ["HTTP_SERVER_ERROR", "上游服务异常，请稍后再试"]
                : ["UNAVAILABLE", "公开资源不可访问"];
      throw new PublicHttpError(code, message, status, url.hostname, after);
    }
    return { res, url };
  }
  throw new LensError("REDIRECT_LIMIT", "重定向次数超限");
}
export async function download(
  stream: string,
  path: string,
  max: number,
  signal?: AbortSignal,
  kind: AssetKind = "stream",
) {
  // Lens.transfer retries the entire body transfer, after partial-file cleanup.
  const { res } = await requestPublicOnce(
    stream,
    kind,
    AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]),
  );
  await saveDownload(res, path, max);
}
/** Persist a validated HTTP response under the task byte ceiling. */
export async function saveDownload(
  res: import("node:http").IncomingMessage,
  path: string,
  max: number,
) {
  if (Number(res.headers["content-length"]) > max) {
    res.destroy();
    throw new LensError("SIZE_LIMIT", "视频超出大小限制");
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > max) done(new LensError("SIZE_LIMIT", "视频超出大小限制"));
      else done(null, chunk);
    },
  });
  const output = await open(path, "wx", 0o600).catch((err) => {
    res.destroy();
    throw err;
  });
  try {
    await pipeline(res, limit, output.createWriteStream());
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
}
