import { it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Lens } from "../packages/core/service.js";
import { configSchema } from "../packages/core/config.js";
import { projectRoot, worker } from "../packages/core/processing.js";
it("invokes the installed server entry point, reads JPEG content and saves cited Markdown", async () => {
  const cache = mkdtempSync(join(tmpdir(), "lens-mcp-"));
  const url = "https://www.douyin.com/video/123456789";
  const lens = new Lens(
    configSchema.parse({ cacheDir: cache, ocrLang: "eng" }),
    {
      resolve: async () => ({
        media: {
          platform: "douyin",
          downloadPermission: "allowed",
          sourceUrl: url,
          id: "123456789",
          author: "Test",
          duration: 1.5,
          title: "Generated test clip",
        },
        stream: "fixture",
        provider: "fixture",
      }),
      download: async (_url, path) => {
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=10:duration=2",
          "-f",
          "lavfi",
          "-i",
          "sine=duration=2",
          "-c:v",
          "mpeg4",
          path,
        ]);
      },
      worker,
    },
  );
  const client = new Client({ name: "lens-test", version: "1.0" });
  try {
    vi.stubEnv("HF_HOME", join(cache, "isolated-models"));
    vi.stubEnv("HF_HUB_CACHE", join(cache, "isolated-models", "hub"));
    vi.stubEnv("HF_HUB_OFFLINE", "1");
    const job = lens.start(url, {
      model: "small",
      asrHotwords: "unobserved-fixture-term",
    });
    expect(await job.done).toMatchObject({
      status: "COMPLETED",
      warnings: ["MODEL_UNAVAILABLE"],
    });
    const env = { PATH: process.env.PATH!, MEDIA_LENS_CACHE: cache };
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(projectRoot, "dist/apps/mcp-server/main.js")],
        env,
        stderr: "ignore",
      }),
    );
    const toolNames = (await client.listTools()).tools.map((t) => t.name);
    expect(toolNames).toContain("media_compare_profile");
    expect(toolNames).toContain("media_save_study");
    expect(toolNames).toContain("media_list_profile");
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    for (const [args, expected] of [
      [{ source: url }, "analysis only"],
      [{ source: url, intent: "create", target: "  " }, "two to three"],
      [
        {
          source: url,
          target: "no-face screen tutorial",
          constraints: "60 seconds",
        },
        "original production plan",
      ],
    ] as const) {
      const p = await client.getPrompt({
        name: "study_media",
        arguments: { ...args },
      });
      expect(p.messages[0].content).toMatchObject({
        type: "text",
        text: expect.stringContaining(expected),
      });
    }
    const study = { taskIds: [job.taskId], analysis: "Opening card [S1:f000]" };
    const report = await call("media_save_study", study);
    function data(res: typeof report) {
      expect(res.isError).toBeFalsy();
      const text = res.content[0];
      if (text.type !== "text") throw Error("no text");
      return JSON.parse(text.text);
    }
    const baseline = data(report);
    const english = data(
      await call("media_save_study", { ...study, language: "en" }),
    );
    expect(readFileSync(english.analysisPath, "utf8")).toContain(
      "## Sources and evidence",
    );
    expect(baseline.creativePath).toBeNull();
    expect(readFileSync(baseline.analysisPath, "utf8")).toContain("0s · f000");
    const directions = data(
      await call("media_save_study", {
        ...study,
        creative: {
          directions: [
            { idea: "A", materials: "A4", opening: "Fold" },
            { idea: "B", materials: "Pen", opening: "Draw" },
          ],
        },
      }),
    );
    expect(directions.mode).toBe("directions");
    expect(directions.analysisPath).not.toBe(baseline.analysisPath);
    expect(readFileSync(directions.creativePath, "utf8")).toContain("Fold");
    const plan = data(
      await call("media_save_study", {
        ...study,
        creative: {
          target: "不露脸录屏",
          constraints: "60 秒",
          title: "试一次",
          cover: "开始",
          openings: ["甲", "乙"],
          shots: [
            { when: "0–60s", visual: "录屏", audio: "口播", edit: "定格" },
          ],
        },
      }),
    );
    expect(readFileSync(plan.creativePath, "utf8")).toContain("60 秒");
    expect(
      (
        await call("media_save_study", {
          ...study,
          analysis: "Invented [S1:f999]",
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call("media_save_study", { ...study, analysis: "No source" }))
        .isError,
    ).toBe(true);
    const a = { taskId: job.taskId };
    for (const name of [
      "media_get_task",
      "media_get_transcript",
      "media_list_frames",
      "media_get_result",
    ])
      expect((await call(name, a)).isError).toBeFalsy();
    const inventory = data(await call("media_get_result", a));
    expect(JSON.stringify(inventory)).not.toContain("unobserved-fixture-term");
    expect(inventory).toMatchObject({
      transcriptStatus: "unavailable",
      platformDuration: 1.5,
      fileDuration: 2,
      processing: {
        requestedModel: "small",
        maxFrames: 30,
        hotwordsConfigured: true,
        promptConfigured: false,
      },
      warnings: ["MODEL_UNAVAILABLE"],
      retained: true,
    });
    expect(inventory.ocr[0].foldedLines).toMatchObject({
      possibleOverlay: expect.any(Number),
      shortUncertain: expect.any(Number),
    });
    expect(inventory.ocr[0]).not.toHaveProperty("rawText");
    expect(
      data(await call("media_get_result", { ...a, includeRawOcr: true }))
        .ocr[0],
    ).toHaveProperty("rawText");
    expect(data(await call("media_get_transcript", a))).toMatchObject({
      status: "unavailable",
      displayText: "",
    });
    const result = await call("media_get_frame", { ...a, frameId: "f000" });
    const content = result.content[0];
    expect(content.type).toBe("image");
    if (content.type === "image")
      expect(
        Buffer.from(content.data, "base64").subarray(0, 2).toString("hex"),
      ).toBe("ffd8");
    expect((await call("media_get_frames", { ...a, limit: 4 })).isError).toBe(
      true,
    );
    expect(
      (await call("media_get_frame", { ...a, frameId: "../source" })).isError,
    ).toBe(true);
    expect((await call("media_get_frames", a)).isError).toBeFalsy();
    await call("media_save_analysis", {
      ...a,
      markdown: "Observed pattern [0s · f000]",
    });
    expect(
      readFileSync(lens.store.file(a.taskId, "analysis.md"), "utf8"),
    ).toContain("f000");
    const cli = (args: string[]) =>
      spawnSync(
        process.execPath,
        [join(projectRoot, "dist/apps/cli/main.js"), ...args],
        { encoding: "utf8", env: { ...process.env, ...env } },
      );
    for (const [field, flag, value, expected] of [
      [
        "asrHotwords",
        "--asr-hotwords",
        "密".repeat(63),
        "asrHotwords 最多 128 个 UTF-8 字节（当前 189）",
      ],
      [
        "asrPrompt",
        "--asr-prompt",
        "隐".repeat(600),
        "asrPrompt 最多 512 个 UTF-16 码元（当前 600）",
      ],
    ] as const) {
      const mcpError = await call("media_analyze", { url, [field]: value });
      expect(mcpError.isError).toBe(true);
      expect(JSON.stringify(mcpError.content)).toContain(expected);
      expect(JSON.stringify(mcpError.content)).not.toContain(value);
      const rejected = cli(["analyze", url, flag, value]);
      expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stderr)).toEqual({
        code: "INVALID_DATA",
        message: expected,
      });
    }
    expect(JSON.parse(cli(["task", a.taskId]).stdout).status).toBe("COMPLETED");
    expect(cli(["frames", a.taskId, "--markdown"]).stdout).toContain(
      "# AgentMediaLens",
    );
    expect(cli(["identify", "file:///tmp/s"]).status).toBe(2);
  } finally {
    vi.unstubAllEnvs();
    await client.close();
    lens.store.db.close();
    rmSync(cache, { recursive: true, force: true });
  }
}, 30000);
