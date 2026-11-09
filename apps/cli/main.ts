#!/usr/bin/env node
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, providerKey } from "../../packages/core/config.js";
import { failure, LensError } from "../../packages/core/contracts.js";
import { projectRoot } from "../../packages/core/processing.js";
import { inspectEvil, identify } from "../../packages/core/providers.js";
import { Lens } from "../../packages/core/service.js";
import { z } from "zod";
import { listProfile } from "../../packages/core/profile.js";
const cli = new Command()
  .name("media-lens")
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
    "检查 douyin 或 bilibili 的读取权限与容量",
    "douyin",
  )
  .action(async (opts) => {
    const platform = z.enum(["douyin", "bilibili"]).parse(opts.platform);
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
      c.provider === "evil0ctal" ? await inspectEvil(c, fetch, platform) : null;
    show({
      node: process.version,
      versions,
      providerReady: providerCheck?.serviceReady ?? null,
      providerCheck,
      hasProviderKey: Boolean(providerKey(c)),
    });
    if (
      Object.values(versions).includes(null) ||
      (providerCheck !== null && providerCheck.code !== "OK")
    )
      process.exitCode = 1;
  });
cli
  .command("profile <url>")
  .description("读取作者公开作品与统计，可分页浏览投稿或合集")
  .option(
    "--view <kind>",
    "overview、posts、collections 或 collection",
    "overview",
  )
  .option("--collection-id <id>", "要读取的作者合集编号")
  .option("--cursor <cursor>", "上次返回的分页游标")
  .option("--count <n>", "每页条数（1–20）", Number, 5)
  .option("--list-only", "仅使用目录统计，跳过缺失点赞数的详情查询")
  .action(async (url, o) =>
    show(
      await listProfile(config(), url, {
        view: o.view,
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
  .option("--provider <name>")
  .action(async (url, o) =>
    show(await service().resolve(url, provider.parse(o.provider))),
  );
cli
  .command("analyze <url>")
  .option("--provider <name>")
  .option("--discard-original", "处理后立即删除原片")
  .option("--keep-playback", "有权保存时，保留访客可观看的播放版本")
  .option("--model <name>")
  .option("--max-frames <n>", "关键帧上限", Number)
  .action(async (url, o) => {
    const lens = service();
    const job = lens.start(url, o);
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
  if (cli.opts().verbose)
    console.error(JSON.stringify({ event: "cli", command: action.name() }));
});
try {
  await cli.parseAsync();
} catch (e) {
  console.error(JSON.stringify(failure(e)));
  process.exitCode = e instanceof LensError && e.code === "INVALID_URL" ? 2 : 1;
}
