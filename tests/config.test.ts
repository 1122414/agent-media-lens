import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectRoot } from "../packages/core/processing.js";

it("identifies local configuration errors in CLI and MCP without exposing values", () => {
  const dir = mkdtempSync(join(tmpdir(), "lens-config-"));
  const file = join(dir, "settings.json");
  const env = {
    ...process.env,
    MEDIA_LENS_CACHE: dir,
    MEDIA_LENS_CONFIG: file,
    EVIL0CTAL_ENDPOINT: "",
  };
  const run = (entry: string, extra?: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        join(projectRoot, "dist/apps", entry, "main.js"),
        ...(entry === "cli" ? ["config"] : []),
      ],
      { encoding: "utf8", env: { ...env, ...extra } },
    );
  try {
    for (const [content, message] of [
      [null, "不存在"],
      ['{"key":private-canary}', "不是合法 JSON"],
      ['{"unknownKey":"private-canary"}', "未知配置项 unknownKey"],
      ['{"maxSeconds":4000}', "maxSeconds 最多 3600（当前 4000）"],
      ['{"maxFrames":0}', "maxFrames 至少 1（当前 0）"],
      ['{"model":"private-canary"}', "model 可选值"],
      ['{"maxSeconds":"private-canary"}', "maxSeconds 类型不正确"],
      [
        '{"asrHotwords":"' + "甲".repeat(43) + '"}',
        "asrHotwords 最多 128 个 UTF-8 字节（当前 129）",
      ],
      ["[]", "顶层必须是 JSON 对象"],
      ["null", "顶层必须是 JSON 对象"],
    ] as const) {
      if (content !== null) writeFileSync(file, content);
      const r = run("cli");
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stderr)).toMatchObject({
        code: "CONFIG",
        message: expect.stringContaining(message),
      });
      expect(r.stderr).toContain(file);
      expect(r.stderr).not.toContain("private-canary");
      expect(r.stdout).toBe("");
    }
    writeFileSync(file, '{"maxSeconds":4000}');
    const mcp = run("mcp-server");
    expect(mcp.status).toBe(1);
    expect(JSON.parse(mcp.stderr)).toEqual(JSON.parse(run("cli").stderr));
    writeFileSync(file, '{"maxSeconds":3600}');
    expect(JSON.parse(run("cli").stdout).maxSeconds).toBe(3600);
    const denied = run("cli", {
      EVIL0CTAL_ENDPOINT: "https://private-canary@example.org/",
    });
    expect(denied.stderr).toContain("环境变量 EVIL0CTAL_ENDPOINT");
    expect(denied.stderr).not.toContain(file);
    expect(denied.stderr).not.toContain("private-canary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
