import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
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
export function checked(input: string, kind: "page" | "stream") {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new LensError("INVALID_URL", "链接格式无效");
  }
  const host = u.hostname;
  const allowed =
    kind === "page"
      ? pages.includes(host)
      : cdns.some((d) => host === d || host.endsWith("." + d));
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
  const found = input.match(/https?:\/\/[^\s，。<>]+/g);
  if (found?.length !== 1)
    throw new LensError("INVALID_URL", "请输入一个抖音作品分享链接");
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
  kind: "page" | "stream",
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
            headers: { "user-agent": "Mozilla/5.0 AgentMediaLens/0.1" },
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
      url = checked(new URL(res.headers.location, url).href, kind);
      if (
        kind === "page" &&
        /^\/(?:share\/)?(?:video|note|slides)\/\d{8,21}\/?$/.test(url.pathname)
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
export async function download(stream: string, path: string, max: number) {
  const { res } = await fetchPublic(
    stream,
    "stream",
    AbortSignal.timeout(120000),
  );
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
  try {
    await pipeline(
      res,
      limit,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
}
