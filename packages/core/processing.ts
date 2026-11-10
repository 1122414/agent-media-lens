import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  durationLimit,
  LensError,
  workerSchema,
  type Media,
  type Stage,
} from "./contracts.js";
import type { Config } from "./config.js";
const parent = fileURLToPath(new URL("../../", import.meta.url));
export const projectRoot = existsSync(
  join(parent, "workers", "media_worker.py"),
)
  ? parent
  : fileURLToPath(new URL("../../../", import.meta.url));
export const appVersion: string = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
).version;
export function worker(
  dir: string,
  c: Config,
  onStage: (s: Stage) => void,
  signal: AbortSignal,
  trackWorker?: (pid: number) => void,
  temporaryPlayback = false,
  albumPages = 0,
  platform?: Media["platform"],
) {
  const script = join(projectRoot, "workers", "media_worker.py");
  const local = join(projectRoot, ".venv", "bin", "python");
  const python =
    process.env.MEDIA_LENS_PYTHON || (existsSync(local) ? local : "python3");
  const env = { ...process.env };
  delete env.EVIL0CTAL_API_KEY;
  env.MEDIA_LENS_ASR_HOTWORDS = c.asrHotwords;
  env.MEDIA_LENS_ASR_PROMPT = c.asrPrompt;
  return new Promise<z.infer<typeof workerSchema>>((ok, fail) => {
    signal.throwIfAborted();
    const child = spawn(
      python,
      [
        script,
        dir,
        ...(albumPages ? ["--album-pages", String(albumPages)] : []),
        ...(temporaryPlayback ? ["--temporary-playback"] : []),
        ...(platform ? ["--platform", platform] : []),
        ...(c.asrFallback ? [] : ["--no-asr-fallback"]),
        "--max-seconds",
        String(c.maxSeconds),
        "--interval",
        String(c.interval),
        "--max-frames",
        String(c.maxFrames),
        "--model",
        c.model,
        "--device",
        c.device,
        "--ocr-lang",
        c.ocrLang,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env,
        detached: process.platform !== "win32",
      },
    );
    let error = "WORKER_FAILED";
    let detail: LensError | undefined;
    let lastStage: Stage = "DOWNLOADING";
    function stop() {
      if (child.pid) {
        try {
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            "SIGKILL",
          );
        } catch {
          /* already exited */
        }
      }
    }
    if (child.pid) {
      try {
        trackWorker?.(child.pid);
      } catch {
        stop();
      }
    }
    const timer = setTimeout(() => {
      error = "WORKER_TIMEOUT";
      stop();
    }, 1800000);
    const abort = () => {
      error = "CANCELLED";
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.stage) {
          lastStage = z
            .enum([
              "EXTRACTING_AUDIO",
              "TRANSCRIBING",
              "EXTRACTING_FRAMES",
              "OCR",
            ])
            .parse(msg.stage);
          onStage(lastStage);
        }
        if (
          msg.error === "DURATION_LIMIT" &&
          typeof msg.seconds === "number" &&
          Number.isFinite(msg.seconds) &&
          msg.seconds > 0
        )
          detail = durationLimit(msg.seconds, c.maxSeconds);
        if (
          ["ffmpeg", "ffprobe", "tesseract"].includes(msg.tool) &&
          ["TOOL_MISSING", "TOOL_FAILED", "TOOL_TIMEOUT"].includes(msg.error)
        )
          detail = new LensError(
            msg.error,
            `${lastStage}：${msg.tool} ${msg.error === "TOOL_MISSING" ? "未安装或不在 PATH" : msg.error === "TOOL_TIMEOUT" ? "执行超时" : "处理失败"}；请运行 media-lens doctor 检查本机环境`,
          );
        if (msg.error === "WORKER_FAILED") {
          const hint = new Map([
            ["PermissionError", "本地文件权限不足，请检查任务目录与模型缓存"],
            ["OSError", "文件系统或设备操作失败，请检查可用空间与权限"],
            ["KeyError", "媒体缺少解码所需的字段"],
            ["RuntimeError", "运行库执行失败，请检查所选设备及依赖"],
            ["ValueError", "本地媒体或工具输出无效"],
          ]).get(msg.type);
          if (hint)
            detail = new LensError(
              "WORKER_FAILED",
              `${lastStage}：${hint}（${msg.type}）`,
            );
        }
        if (
          [
            "DURATION_LIMIT",
            "INVALID_VIDEO",
            "IMAGE_LIMIT",
            "INVALID_IMAGE",
          ].includes(msg.error)
        )
          error = msg.error;
      } catch {
        stop();
      }
    });
    child.once("error", () =>
      fail(new LensError("WORKER_START", "无法启动 Python Worker")),
    );
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code !== 0) {
        fail(
          signal.aborted || error === "WORKER_TIMEOUT"
            ? new LensError(error, `${lastStage}：任务取消或超时`)
            : (detail ??
                new LensError(
                  error,
                  `${lastStage}：媒体处理失败，请运行 media-lens doctor 检查环境`,
                )),
        );
        return;
      }
      try {
        ok(
          workerSchema.parse(
            JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")),
          ),
        );
      } catch (e) {
        fail(e);
      }
    });
  });
}
