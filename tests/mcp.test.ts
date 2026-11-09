import { it, expect } from "vitest";
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
          duration: 2,
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
    const job = lens.start(url);
    expect((await job.done).status).toBe("COMPLETED");
    const env = { PATH: process.env.PATH!, MEDIA_LENS_CACHE: cache };
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(projectRoot, "dist/apps/mcp-server/main.js")],
        env,
        stderr: "ignore",
      }),
    );
    expect((await client.listTools()).tools.length).toBe(10);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const a = { taskId: job.taskId };
    for (const name of [
      "media_get_task",
      "media_get_transcript",
      "media_list_frames",
      "media_get_result",
    ])
      expect((await call(name, a)).isError).toBeFalsy();
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
    expect(JSON.parse(cli(["task", a.taskId]).stdout).status).toBe("COMPLETED");
    expect(cli(["frames", a.taskId, "--markdown"]).stdout).toContain(
      "# AgentMediaLens",
    );
    expect(cli(["identify", "file:///tmp/s"]).status).toBe(2);
  } finally {
    await client.close();
    lens.store.db.close();
    rmSync(cache, { recursive: true, force: true });
  }
}, 30000);
