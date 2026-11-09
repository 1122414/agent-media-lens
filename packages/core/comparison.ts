import { z } from "zod";
import type { Config } from "./config.js";
import { failure } from "./contracts.js";
import { listProfile } from "./profile.js";

export const comparisonOptions = z.strictObject({
  sampleSize: z.int().min(2).max(60).default(30),
  pairs: z.int().min(1).max(3).default(3),
  auth: z.enum(["guest", "local-login"]).default("guest"),
  collectionId: z
    .string()
    .regex(/^[1-9]\d{0,20}$/)
    .optional(),
});
type Page = Awaited<ReturnType<typeof listProfile>>;
type Work = Page["items"][number];
const day = 86400000;
function date(w: Work) {
  return w.publishedAt ? Date.parse(w.publishedAt) : null;
}

// Rank across the observed sample; nominate high posts within each format.
// Controls come from the middle ranks of that format, never from the high group.
export function matchPosts(items: Work[], limit: number, observedAt: string) {
  const known = items
    .filter((w) => w.stats.likes !== null)
    .sort(
      (a, b) => b.stats.likes! - a.stats.likes! || a.id.localeCompare(b.id),
    );
  const formats = new Map<string, Work[]>();
  for (const work of known) {
    const group = formats.get(work.kind) ?? [];
    group.push(work);
    formats.set(work.kind, group);
  }
  const used = new Set<string>();
  const pairs = [];
  const elapsed = (w: Work) =>
    date(w) === null
      ? null
      : Math.max(0, (Date.parse(w.statsAt || observedAt) - date(w)!) / day);
  const compact = (w: Work) => ({
    id: w.id,
    title: w.title,
    url: w.url,
    kind: w.kind,
    publishedAt: w.publishedAt,
    duration: w.duration,
    likes: w.stats.likes,
    statsAt: w.statsAt,
    pinned: w.pinned,
    under48Hours: elapsed(w) === null ? null : elapsed(w)! < 2,
  });
  for (const high of known) {
    const group = formats.get(high.kind)!;
    if (group.indexOf(high) >= Math.ceil(group.length / 4)) continue;
    const controls = group
      .slice(
        Math.ceil(group.length / 4),
        Math.max(2, Math.min(group.length - 1, Math.ceil(group.length * 0.75))),
      )
      .filter((w) => !used.has(w.id) && w.stats.likes! < high.stats.likes!);
    const gap = (w: Work) =>
      date(high) === null || date(w) === null
        ? Infinity
        : Math.abs(date(high)! - date(w)!) / day;
    const lengthGap = (w: Work) =>
      !w.duration || !high.duration
        ? Infinity
        : Math.abs(Math.log(w.duration / high.duration));
    controls.sort(
      (a, b) =>
        gap(a) - gap(b) ||
        lengthGap(a) - lengthGap(b) ||
        Math.abs(group.indexOf(a) - (group.length - 1) / 2) -
          Math.abs(group.indexOf(b) - (group.length - 1) / 2),
    );
    const control = controls[0];
    if (!control) continue;
    used.add(control.id);
    pairs.push({
      high: compact(high),
      ordinary: compact(control),
      formatPopulation: group.length,
      daysApart: Number.isFinite(gap(control))
        ? Math.round(gap(control) * 10) / 10
        : null,
    });
    if (pairs.length === limit) break;
  }
  return {
    rankable: known.length,
    unknownLikes: items.length - known.length,
    pairs,
  };
}

export async function compareProfile(
  c: Config,
  url: string,
  options: z.input<typeof comparisonOptions> = {},
  read = listProfile,
) {
  const o = comparisonOptions.parse(options),
    count = Math.min(10, o.sampleSize);
  const first = await read(c, url, {
    auth: o.auth,
    view: o.collectionId ? "collection" : "overview",
    collectionId: o.collectionId,
    count,
  });
  const seen = new Map<string, Work>(),
    cursors = new Set<string>(),
    notices = new Set<string>();
  let page = first,
    pages = 0,
    stopped = "end";
  while (true) {
    pages++;
    for (const e of [
      page.postListError,
      page.collectionListError,
      page.visibilityError,
    ])
      if (e) notices.add(e);
    let overflow = false;
    for (const w of page.items) {
      if (seen.has(w.id)) continue;
      if (seen.size === o.sampleSize) {
        overflow = true;
        break;
      }
      seen.set(w.id, w);
    }
    const metricErrors = page.items.flatMap((w) =>
      w.statsError && w.statsError !== "NOT_REQUESTED" ? [w.statsError] : [],
    );
    for (const code of metricErrors) notices.add(code);
    if (
      page.visibilityError ||
      metricErrors.some((code) =>
        [
          "RATE_LIMITED",
          "UPSTREAM_RISK_CONTROL",
          "IDENTITY_POOL_EXHAUSTED",
          "PROVIDER_AUTH",
          "PROVIDER_CONNECTION",
        ].includes(code),
      )
    ) {
      stopped = "verification_limited";
      break;
    }
    if (page.guestLimited) {
      stopped = "guest_preview";
      break;
    }
    if (page.view === "collections") {
      stopped = "uploads_unavailable";
      break;
    }
    if (overflow || (seen.size >= o.sampleSize && page.nextCursor)) {
      stopped = "sample_limit";
      break;
    }
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor)) {
      stopped = "repeated_cursor";
      break;
    }
    if (pages >= 6) {
      stopped = "page_limit";
      break;
    }
    cursors.add(page.nextCursor);
    try {
      page = await read(c, first.profile.url, {
        auth: o.auth,
        view: first.view === "collection" ? "collection" : "posts",
        collectionId: first.collectionId ?? undefined,
        cursor: page.nextCursor,
        count,
      });
    } catch (e) {
      notices.add(failure(e).code);
      stopped = "page_error";
      break;
    }
  }
  const observedAt = new Date().toISOString();
  return {
    profile: first.profile,
    view: first.view,
    collectionId: first.collectionId,
    requested: o.sampleSize,
    observed: seen.size,
    pages,
    stopped,
    notices: [...notices],
    observedAt,
    ...matchPosts([...seen.values()], o.pairs, observedAt),
  };
}
