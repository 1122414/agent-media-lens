#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { config } from "../../packages/core/config.js";
import { failure, LensError } from "../../packages/core/contracts.js";
import { Lens } from "../../packages/core/service.js";
const lens = new Lens(config());
const server = new McpServer({
  name: "agent-media-lens",
  version: "0.2.0",
});
const taskId = z.uuid(),
  url = z.string().min(1).max(4096),
  provider = z.enum(["evil0ctal", "native"]).optional();
const windowFields = {
  taskId,
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
};
const page = z.int().min(1).max(120).optional();
const window = z
  .object(windowFields)
  .refine(
    (v) => v.start === undefined || v.end === undefined || v.start <= v.end,
  );
function json(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 96000)
    throw new LensError("TEXT_LIMIT", "结果过长，请缩小时间范围或分页读取");
  return { content: [{ type: "text" as const, text }] };
}
async function call<T>(name: string, fn: () => T | Promise<T>) {
  try {
    const out = await fn();
    console.error(JSON.stringify({ event: "tool", name, outcome: "ok" }));
    return out;
  } catch (e) {
    const error = failure(e);
    console.error(JSON.stringify({ event: "tool", name, code: error.code }));
    return { ...json({ error }), isError: true };
  }
}
server.registerTool(
  "media_resolve",
  {
    description:
      "Resolve one public Douyin video or photo album URL and return normalized metadata.",
    inputSchema: z.object({ url, provider }),
  },
  ({ url, provider }) =>
    call("resolve", async () => json(await lens.resolve(url, provider))),
);
server.registerTool(
  "media_analyze",
  {
    description:
      "Start local media processing. Poll media_get_task before reading evidence.",
    inputSchema: z.object({
      url,
      provider,
      discardOriginal: z.boolean().optional(),
      keepPlayback: z
        .boolean()
        .optional()
        .describe(
          "Retain the normal guest playback rendition when the user has rights to save it.",
        ),
      maxFrames: z.int().min(1).max(120).optional(),
      model: z
        .enum(["auto", "tiny", "base", "small", "medium", "large-v3"])
        .optional(),
    }),
  },
  ({ url, ...opts }) =>
    call("analyze", () => {
      const job = lens.start(url, opts);
      return json(lens.store.task(job.taskId));
    }),
);
server.registerTool(
  "media_get_task",
  {
    description: "Read task stage, timings, error or artifacts.",
    inputSchema: z.object({ taskId }),
  },
  (a) => call("task", () => json(lens.store.task(a.taskId))),
);
server.registerTool(
  "media_get_transcript",
  {
    description:
      "Read timestamped speech, optionally filtered by seconds and segment offset.",
    inputSchema: z.object({
      ...windowFields,
      offset: z.int().nonnegative().default(0),
      limit: z.int().min(1).max(150).default(50),
    }),
  },
  (a) =>
    call("transcript", () => {
      window.parse(a);
      return json(lens.transcript(a.taskId, a.start, a.end, a.offset, a.limit));
    }),
);
server.registerTool(
  "media_list_frames",
  {
    description: "List frame IDs and media timestamps in a time window.",
    inputSchema: z.object({ ...windowFields, page }),
  },
  (a) =>
    call("list_frames", () => {
      window.parse(a);
      return json(lens.frames(a.taskId, a.start, a.end, a.page));
    }),
);
server.registerTool(
  "media_get_frame",
  {
    description:
      "Read one real JPEG by frameId or nearest timestamp in seconds.",
    inputSchema: z.object({
      taskId,
      page,
      frameId: z
        .string()
        .regex(/^f\d{3}$/)
        .optional(),
      timestamp: z.number().nonnegative().optional(),
    }),
  },
  (a) =>
    call("get_frame", () => {
      if ((a.frameId === undefined) === (a.timestamp === undefined))
        throw new LensError("INVALID_SELECTOR", "请选择帧 ID 或时间戳");
      return { content: [lens.image(a.taskId, a)] };
    }),
);
server.registerTool(
  "media_get_frames",
  {
    description: "Read at most three timestamped JPEGs in one window.",
    inputSchema: z.object({
      ...windowFields,
      page,
      limit: z.int().min(1).max(3).default(3),
    }),
  },
  (a) =>
    call("get_frames", () => {
      window.parse(a);
      return {
        content: lens
          .frames(a.taskId, a.start, a.end, a.page)
          .slice(0, a.limit)
          .flatMap((f) => [
            ...json({ id: f.id, page: f.page, timestamp: f.timestamp }).content,
            lens.image(a.taskId, { frameId: f.id }),
          ]),
      };
    }),
);
server.registerTool(
  "media_get_result",
  {
    description:
      "Read metadata, evidence inventory and paged OCR. Full JSON is stored in the task directory.",
    inputSchema: z.object({
      taskId,
      offset: z.int().nonnegative().default(0),
      limit: z.int().min(1).max(10).default(3),
    }),
  },
  (a) =>
    call("result", () => {
      const r = lens.result(a.taskId);
      return json({
        schemaVersion: r.schemaVersion,
        media: r.media,
        provider: r.provider,
        artifacts: r.artifacts,
        frames: r.frames,
        segmentCount: r.transcript.segments.length,
        ocr: r.ocr.slice(a.offset, a.offset + a.limit),
        ocrCount: r.ocr.length,
      });
    }),
);
server.registerTool(
  "media_save_analysis",
  {
    description:
      "Save the client's time-cited Markdown report inside this completed task.",
    inputSchema: z.object({ taskId, markdown: z.string().min(1).max(64000) }),
  },
  (a) =>
    call("save_analysis", () => {
      lens.result(a.taskId);
      const path = lens.store.file(a.taskId, "analysis.md");
      writeFileSync(path, a.markdown, { mode: 0o600 });
      return json({ path });
    }),
);
server.registerTool(
  "media_cleanup",
  {
    description:
      "Delete expired original videos for terminal tasks and retain derived evidence.",
    inputSchema: z.object({}),
  },
  () => call("cleanup", () => json(lens.store.cleanup())),
);
process.stdin.on("end", () => lens.cancelAll());
await server.connect(new StdioServerTransport());
