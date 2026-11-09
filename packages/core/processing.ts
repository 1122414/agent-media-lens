import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { z } from "zod";
import { LensError, workerSchema, type Stage } from "./contracts.js";
import type { Config } from "./config.js";
const parent = fileURLToPath(new URL("../../", import.meta.url));
export const projectRoot = existsSync(
  join(parent, "workers", "media_worker.py"),
)
  ? parent
  : fileURLToPath(new URL("../../../", import.meta.url));
export function worker(
  dir: string,
  c: Config,
  onStage: (s: Stage) => void,
  signal: AbortSignal,
) {
  const script = join(projectRoot, "workers", "media_worker.py");
  const local = join(projectRoot, ".venv", "bin", "python");
  const python =
    process.env.MEDIA_LENS_PYTHON || (existsSync(local) ? local : "python3");
  const env = { ...process.env };
  delete env.EVIL0CTAL_API_KEY;
  return new Promise<z.infer<typeof workerSchema>>((ok, fail) => {
    signal.throwIfAborted();
    const child = spawn(
      python,
      [
        script,
        dir,
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
        if (msg.stage)
          onStage(
            z
              .enum([
                "EXTRACTING_AUDIO",
                "TRANSCRIBING",
                "EXTRACTING_FRAMES",
                "OCR",
              ])
              .parse(msg.stage),
          );
        if (
          ["DURATION_LIMIT", "INVALID_VIDEO", "IMAGE_LIMIT"].includes(msg.error)
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
        fail(new LensError(error, "媒体处理失败，请检查任务阶段与环境"));
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
