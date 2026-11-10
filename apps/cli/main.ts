#!/usr/bin/env node
import { diagnostics } from "../../packages/core/diagnostics.js";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, providerKey } from "../../packages/core/config.js";
import { failure, LensError } from "../../packages/core/contracts.js";
import { appVersion, projectRoot } from "../../packages/core/processing.js";
import { inspectEvil, identify } from "../../packages/core/providers.js";
import { Lens } from "../../packages/core/service.js";
import { z } from "zod";
import { listProfile } from "../../packages/core/profile.js";
import { compareProfile } from "../../packages/core/comparison.js";
const cli = new Command()
  .name("media-lens")
  .version(appVersion)
  .description("理解公开抖音作品和 B 站视频，读取本地证据")
  .option("--json", "输出 JSON（默认）")
  .option("--markdown", "输出 Markdown")
  .option("--verbose", "输出结构化诊断日志到 stderr");
function show(value: unknown) {
  const json = JSON.stringify(value, null, 2);
  console.log(
    cli.opts().markdown
      ? "# AgentMediaLens\n\n\u0060\u0060\u0060json\n" +
          json.replaceAll("\u0060", "\\u0060") +
          "\n\u0060\u0060\u0060"
      : json,
  );
}
function service() {
  return new Lens(config());
}
const provider = z.enum(["evil0ctal", "native"]).optional();
cli.command("config").action(() => show(config()));
cli
  .command("doctor")
  .option(
    "--platform <name>",
    "检查 douyin / bilibili 的服务配置，或 xiaohongshu 的本地处理环境",
    "douyin",
  )
  .action(async (opts) => {
    const platform = z
      .enum(["douyin", "bilibili", "xiaohongshu"])
      .parse(opts.platform);
    const c = config();
    const versions: Record<string, string | null> = {};
    const python =
      process.env.MEDIA_LENS_PYTHON ||
      join(projectRoot, ".venv", "bin", "python");
    for (const [key, cmd, args] of [
      ["ffmpeg", "ffmpeg", ["-version"]],
      ["ffprobe", "ffprobe", ["-version"]],
      ["ocr", "tesseract", ["--version"]],
      [
        "asr",
        existsSync(python) ? python : "python3",
        ["-c", "import faster_whisper; print(faster_whisper.__version__)"],
      ],
    ] as const) {
      try {
        versions[key] = execFileSync(cmd, [...args], {
          encoding: "utf8",
          timeout: 20000,
          stdio: ["ignore", "pipe", "ignore"],
        }).split("\n")[0];
      } catch {
        versions[key] = null;
      }
    }
    const providerCheck =
      platform !== "xiaohongshu" && c.provider === "evil0ctal"
        ? await inspectEvil(c, fetch, platform)
        : null;
    show({
      node: process.version,
      versions,
      providerReady: providerCheck?.serviceReady ?? null,
      providerCheck,
      ...(platform === "xiaohongshu"
        ? { accessMode: "native-guest", noteAccess: "untested" }
        : { hasProviderKey: Boolean(providerKey(c)) }),
    });
    if (
      Object.values(versions).includes(null) ||
      (providerCheck !== null && providerCheck.code !== "OK")
    )
      process.exitCode = 1;
  });
cli
  .command("douyin-login")
  .description("在本机终端配置只用于抖音公开投稿的登录身份")
  .option("--clipboard", "Mac：确认后从剪贴板读取一次 Cookie，避免终端长行限制")
  .action((opts) => {
    try {
      execFileSync(
        "python3",
        [
          join(projectRoot, "scripts", "douyin-login.py"),
          ...(opts.clipboard ? ["--clipboard"] : []),
        ],
        { stdio: "inherit" },
      );
    } catch {
      process.exitCode = 1;
    }
  });
cli
  .command("compare <url>")
  .description("从实读的作者投稿或指定合集按点赞和形式选对照样本（不下载媒体）")
  .option("--sample-size <n>", "最多读取的不同作品数（2–60）", Number, 30)
  .option("--pairs <n>", "最多配对数（1–3）", Number, 3)
  .option("--collection-id <id>", "只在这个作者合集中选样")
  .option("--local-login", "仅此次查询使用已配置的抖音本机登录")
  .action(async (url, o) =>
    show(
      await compareProfile(config(), url, {
        sampleSize: o.sampleSize,
        pairs: o.pairs,
        collectionId: o.collectionId,
        auth: o.localLogin ? "local-login" : "guest",
      }),
    ),
  );
cli
  .command("profile <url>")
  .description("读取作者公开作品与统计，可分页浏览投稿或合集")
  .option(
    "--view <kind>",
    "overview、posts、collections 或 collection",
    "overview",
  )
  .option("--local-login", "仅此次抖音投稿查询使用本机登录身份")
  .option("--collection-id <id>", "要读取的作者合集编号")
  .option("--cursor <cursor>", "上次返回的分页游标")
  .option("--count <n>", "每页条数（1–20）", Number, 5)
  .option("--list-only", "仅使用目录统计，跳过缺失点赞数的详情查询")
  .action(async (url, o) =>
    show(
      await listProfile(config(), url, {
        view: o.view,
        auth: o.localLogin ? "local-login" : "guest",
        collectionId: o.collectionId,
        cursor: o.cursor,
        count: o.count,
        details: !o.listOnly,
      }),
    ),
  );
cli.command("identify <url>").action(async (url) => show(await identify(url)));
cli
  .command("resolve <url>")
  .description("读取平台元数据；实际文件时长与留存状态请在 analyze 完成后查看")
  .option(
    "--provider <name>",
    "抖音详情与视频使用 evil0ctal；native 可识别抖音链接",
  )
  .action(async (url, o) =>
    show(await service().resolve(url, provider.parse(o.provider))),
  );
cli
  .command("analyze <url>")
  .option(
    "--provider <name>",
    "抖音详情与视频使用 evil0ctal；native 可识别抖音链接",
  )
  .option("--discard-original", "处理后立即删除原片")
  .option("--keep-playback", "有权保存时，保留访客可观看的播放版本")
  .option("--model <name>")
  .option(
    "--strict-model",
    "仅使用本机缓存的指定模型，不下载、不回退；缺少模型时仍返回画面",
  )
  .option(
    "--asr-prompt <text>",
    "转写开头的上下文或书写风格，最多 512 个 UTF-16 码元",
  )
  .option(
    "--asr-hotwords <terms>",
    "各窗口重复使用的专名；128 个 UTF-8 字节可容纳 9 个用半角逗号隔开的常用四字词。启用逐词对齐，转写可能更慢",
  )
  .option("--max-frames <n>", "关键帧上限", Number)
  .action(async (url, o) => {
    const lens = service();
    const { strictModel, ...options } = o;
    const job = lens.start(
      url,
      strictModel ? { ...options, asrFallback: false } : options,
    );
    const abort = () => lens.cancelAll();
    process.once("SIGINT", abort);
    try {
      const task = await job.done;
      show(task);
      if (task.status !== "COMPLETED") process.exitCode = 1;
    } finally {
      process.off("SIGINT", abort);
    }
  });
cli.command("task <id>").action((id) => show(service().store.task(id)));
cli
  .command("transcript <id>")
  .option("--offset <n>", "分段偏移", Number, 0)
  .action((id, o) =>
    show(
      service().transcript(
        id,
        0,
        Infinity,
        z.int().nonnegative().parse(o.offset),
      ),
    ),
  );
cli
  .command("frames <id>")
  .option("--page <n>", "只看指定图集页码", Number)
  .action((id, o) =>
    show(
      service().frames(
        id,
        undefined,
        undefined,
        z.int().positive().optional().parse(o.page),
      ),
    ),
  );
cli.command("result <id>").action((id) => show(service().result(id)));
cli.command("cleanup").action(() => show(service().store.cleanup()));
cli.hook("preAction", (_p, action) => {
  if (cli.opts().verbose) {
    diagnostics.subscribe((event) => console.error(JSON.stringify(event)));
    console.error(JSON.stringify({ event: "cli", command: action.name() }));
  }
});
try {
  await cli.parseAsync();
} catch (e) {
  console.error(JSON.stringify(failure(e)));
  process.exitCode = e instanceof LensError && e.code === "INVALID_URL" ? 2 : 1;
}
