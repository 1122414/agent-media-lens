import { z } from "zod";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { projectRoot } from "./processing.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LensError } from "./contracts.js";
export const asrHotwords = z
  .string()
  .trim()
  .max(128)
  .refine(
    (s) => Buffer.byteLength(s, "utf8") <= 128,
    "词表最多 128 个 UTF-8 字节",
  );
export const configSchema = z.strictObject({
  cacheDir: z
    .string()
    .min(1)
    .default(join(homedir(), ".cache", "agent-media-lens")),
  provider: z.enum(["evil0ctal", "native"]).default("evil0ctal"),
  fallback: z.boolean().default(false),
  endpoint: z.url().default("http://127.0.0.1:8000"),
  maxBytes: z.int().min(1024).max(1000000000).default(500000000),
  maxSeconds: z.int().min(1).max(3600).default(600),
  maxDiskBytes: z.int().positive().default(10000000000),
  concurrency: z.int().min(1).max(8).default(1),
  retentionDays: z.number().nonnegative().max(3650).default(7),
  interval: z.number().min(1).max(60).default(4),
  maxFrames: z.int().min(1).max(120).default(30),
  model: z
    .enum(["auto", "tiny", "base", "small", "medium", "large-v3"])
    .default("auto"),
  device: z.enum(["auto", "cpu", "cuda"]).default("auto"),
  asrFallback: z.boolean().default(true),
  asrHotwords: asrHotwords.default(""),
  asrPrompt: z.string().trim().max(512).default(""),
  ocrLang: z
    .string()
    .regex(/^[a-z_]+(?:\+[a-z_]+)*$/)
    .default("chi_sim+eng"),
});
export type Config = z.infer<typeof configSchema>;
export function config(): Config {
  const data = process.env.MEDIA_LENS_CONFIG
    ? JSON.parse(readFileSync(process.env.MEDIA_LENS_CONFIG, "utf8"))
    : {};
  const c = configSchema.parse({
    ...data,
    ...(process.env.MEDIA_LENS_CACHE
      ? { cacheDir: process.env.MEDIA_LENS_CACHE }
      : {}),
    ...(process.env.EVIL0CTAL_ENDPOINT
      ? { endpoint: process.env.EVIL0CTAL_ENDPOINT }
      : {}),
  });
  const u = new URL(c.endpoint);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw new LensError("CONFIG", "Provider 需要 HTTPS 或本机回环地址");
  c.cacheDir = resolve(c.cacheDir);
  return c;
}

// Desktop MCP clients may start outside the shell that configured the provider.
// Bind the checkout's private reader file to its original loopback service.
export function providerKey(
  c: Config,
  path = join(projectRoot, ".cache", "provider", "platform-reader.env"),
) {
  if (process.env.EVIL0CTAL_API_KEY !== undefined)
    return process.env.EVIL0CTAL_API_KEY;
  if (new URL(c.endpoint).origin !== "http://127.0.0.1:8000" || !process.getuid)
    return undefined;
  const raw = privateSetting(path);
  if (raw === undefined) return undefined;
  const value = /^EVIL0CTAL_API_KEY=([A-Za-z0-9_.-]+)$/.exec(raw)?.[1];
  if (!value) throw new LensError("PROVIDER_AUTH", "本机只读凭证格式无效");
  return value;
}

function privateSetting(path: string) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o077) !== 0 ||
      st.size > 1024
    )
      throw new LensError(
        "PROVIDER_AUTH",
        "本机只读凭证需要当前用户持有并设为 0600",
      );
    return readFileSync(fd, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LensError("PROVIDER_AUTH", "请检查本机只读凭证格式与权限");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const loginOrigin = "http://127.0.0.1:8000";
export function douyinLogin(
  c: Config,
  path = join(projectRoot, ".cache", "provider", "douyin-login.json"),
) {
  if (new URL(c.endpoint).href !== loginOrigin + "/")
    throw new LensError(
      "LOCAL_LOGIN_ENDPOINT",
      "本机登录仅支持 127.0.0.1:8000",
    );
  const proxyOptIn =
    process.env.NODE_USE_ENV_PROXY === "1" ||
    process.execArgv.includes("--use-env-proxy") ||
    /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? "");
  if (
    proxyOptIn &&
    !(process.env.no_proxy ?? process.env.NO_PROXY ?? "")
      .split(",")
      .some((s) => ["*", "127.0.0.1", "127.0.0.1:8000"].includes(s.trim()))
  )
    throw new LensError(
      "LOCAL_LOGIN_PROXY",
      "请在 NO_PROXY 中加入 127.0.0.1，再使用本机登录",
    );
  const raw = privateSetting(path);
  if (!raw) throw loginNeeded();
  try {
    const settings = z
      .object({
        apiKey: z.string().regex(/^[A-Za-z0-9_.-]{8,256}$/),
        identityId: z.uuid().nullable(),
      })
      .parse(JSON.parse(raw));
    if (settings.identityId)
      return { ...settings, identityId: settings.identityId };
  } catch {
    throw new LensError("LOCAL_LOGIN_CONFIG", "本机登录配置无效；请重新配置");
  }
  throw loginNeeded();
}

export function loginNeeded() {
  return new LensError(
    "LOCAL_LOGIN_REQUIRED",
    "请在自己的终端运行 media-lens douyin-login 完成本机登录；无需把 Cookie 发给 Agent",
  );
}
