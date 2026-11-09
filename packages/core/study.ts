import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Lens } from "./service.js";
import { LensError } from "./contracts.js";

const line = z.string().trim().min(1).max(1600);
const creative = z.union([
  z.strictObject({
    constraints: line.optional(),
    directions: z
      .array(z.strictObject({ idea: line, materials: line, opening: line }))
      .min(2)
      .max(3),
  }),
  z.strictObject({
    target: line,
    constraints: line.optional(),
    title: line,
    cover: line,
    openings: z.tuple([line, line]),
    shots: z
      .array(
        z.strictObject({
          when: line,
          visual: line,
          audio: line,
          edit: line,
          caption: line.optional(),
        }),
      )
      .min(1)
      .max(40),
  }),
]);
export const studyOptions = z.strictObject({
  taskIds: z
    .array(z.uuid())
    .min(1)
    .max(6)
    .refine((v) => new Set(v).size === v.length, "来源任务不能重复"),
  analysis: z.string().trim().min(1).max(48000),
  creative: creative.optional(),
  language: z.enum(["zh", "en"]).default("zh"),
});
type Creative = z.infer<typeof creative>;
function renderCreative(c: Creative, en: boolean) {
  const brief = c.constraints
    ? [
        (en ? "Materials and constraints: " : "素材与限制：") + c.constraints,
        "",
      ]
    : [];
  if ("directions" in c)
    return [
      en ? "# Original directions" : "# 原创方向",
      "",
      ...brief,
      ...c.directions.flatMap((d, i) => [
        "## " + (i + 1) + ". " + d.idea,
        "",
        (en ? "Required materials: " : "需要的素材：") + d.materials,
        "",
        (en ? "First shot: " : "第一镜：") + d.opening,
        "",
      ]),
    ].join("\n");
  return [
    "# " + c.title,
    "",
    (en ? "Creative goal: " : "创作目标：") + c.target,
    "",
    ...brief,
    (en ? "Cover: " : "封面：") + c.cover,
    "",
    en ? "## Alternative openings" : "## 两种开头",
    "",
    ...c.openings.map((v, i) => i + 1 + ". " + v),
    "",
    en ? "## Shot and edit timeline" : "## 分镜与剪辑时间线",
    "",
    ...c.shots.flatMap((s) => [
      "### " + s.when,
      "",
      (en ? "Visual: " : "画面：") + s.visual,
      "",
      (en ? "Lines and sound: " : "台词与声音：") + s.audio,
      "",
      (en ? "Edit: " : "剪辑：") + s.edit,
      "",
      ...(s.caption ? [(en ? "Caption: " : "字幕：") + s.caption, ""] : []),
    ]),
  ].join("\n");
}
export function saveStudy(lens: Lens, input: z.input<typeof studyOptions>) {
  const o = studyOptions.parse(input),
    results = o.taskIds.map((id) => lens.result(id));
  const en = o.language === "en";
  const refs = new Map<string, string>(),
    used = new Set<number>();
  for (const match of o.analysis.matchAll(/\[S(\d+):([^\]\n]*)\]/g)) {
    const n = Number(match[1]),
      r = results[n - 1],
      token = match[2];
    let label: string | undefined;
    if (r && String(n) === match[1]) {
      const f = r.frames.find((v) => v.id === token);
      if (f)
        label = [
          f.page && (en ? "Page " + f.page : "第 " + f.page + " 页"),
          f.timestamp == null
            ? en
              ? "still"
              : "静态图"
            : Number(f.timestamp.toFixed(3)) + "s",
          f.id,
        ]
          .filter(Boolean)
          .join(" · ");
      else if (/^t[1-9]\d*$/.test(token)) {
        const seg = r.transcript.segments[Number(token.slice(1)) - 1];
        if (seg)
          label =
            seg.start + "–" + seg.end + (en ? "s · transcript" : "s · 转写");
      }
    }
    if (!label)
      throw new LensError(
        "INVALID_CITATION",
        "无对应证据：" + match[0].slice(0, 50),
      );
    refs.set(match[0], label);
    used.add(n);
  }
  if (used.size !== results.length)
    throw new LensError(
      "MISSING_CITATION",
      "每份来源至少引用一处 [S1:f000] 或 [S1:t1] 格式的实际证据",
    );
  const id = randomUUID(),
    dir = o.taskIds[0],
    analysisPath = lens.store.file(dir, "study-" + id + ".md"),
    creativePath = o.creative
      ? lens.store.file(dir, "creative-" + id + ".md")
      : null;
  const sourceLines = results.map(
    (r, i) => "- S" + (i + 1) + ": " + r.media.sourceUrl + " · " + o.taskIds[i],
  );
  const md = [
    o.analysis,
    "",
    en ? "## Sources and evidence" : "## 来源与证据",
    "",
    ...sourceLines,
    "",
    ...[...refs].map(([key, value]) => "- " + key + (en ? ": " : "：") + value),
    "",
  ].join("\n");
  const plan = o.creative ? renderCreative(o.creative, en) : null;
  lens.store.transaction(() => {
    lens.store.ensureSpace(
      Buffer.byteLength(md) + (plan ? Buffer.byteLength(plan) : 0),
    );
    writeFileSync(analysisPath, md, { mode: 0o600, flag: "wx" });
    try {
      if (plan && creativePath)
        writeFileSync(creativePath, plan, { mode: 0o600, flag: "wx" });
    } catch (e) {
      unlinkSync(analysisPath);
      throw e;
    }
  });
  return {
    analysisPath,
    creativePath,
    mode: !o.creative
      ? "analysis"
      : "directions" in o.creative
        ? "directions"
        : "production",
    sourceCount: results.length,
  };
}
