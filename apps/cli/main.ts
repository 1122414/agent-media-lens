#!/usr/bin/env node
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../packages/core/config.js";
import { failure, LensError } from "../../packages/core/contracts.js";
import { projectRoot } from "../../packages/core/processing.js";
import { evil, identify } from "../../packages/core/providers.js";
import { Lens } from "../../packages/core/service.js";
import { z } from "zod";
const cli = new Command()
  .name("media-lens")
  .description("理解公开抖音视频，读取本地证据")
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
cli.command("doctor").action(async () => {
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
  const ready = await evil(c).health();
  show({
    node: process.version,
    versions,
    providerReady: ready,
    hasProviderKey: Boolean(process.env.EVIL0CTAL_API_KEY),
  });
  if (
    Object.values(versions).includes(null) ||
    (c.provider === "evil0ctal" && (!ready || !process.env.EVIL0CTAL_API_KEY))
  )
    process.exitCode = 1;
});
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
cli.command("frames <id>").action((id) => show(service().frames(id)));
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
