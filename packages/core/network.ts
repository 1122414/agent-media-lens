import { lookup } from "node:dns/promises";
import { get } from "node:https";

import { open, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ipaddr from "ipaddr.js";
import { LensError } from "./contracts.js";
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
type UrlKind = "page" | "bili-page" | "stream" | "bili-stream" | "photo";
function allowedHost(host: string, kind: UrlKind, redirectedFrom?: URL) {
  switch (kind) {
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
    throw new LensError("INVALID_URL", "请输入一个抖音或哔哩哔哩作品链接");
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
export async function fetchPublic(
  input: string,
  kind: UrlKind,
  signal: AbortSignal,
) {
  let url = checked(input, kind);
  for (let hop = 0; hop <= 4; hop++) {
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
    if (
      [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
      res.headers.location
    ) {
      res.destroy();
      url = checked(new URL(res.headers.location, url).href, kind, url);
      if (
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
      throw new LensError("UNAVAILABLE", "公开资源不可访问");
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
  kind: "stream" | "bili-stream" | "photo" = "stream",
) {
  const { res } = await fetchPublic(
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
