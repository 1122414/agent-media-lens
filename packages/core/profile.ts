import { z } from "zod";
import type { Config } from "./config.js";
import { failure, LensError } from "./contracts.js";
import { fetchPublic } from "./network.js";
import { queryProvider } from "./providers.js";

const digits = /^[1-9]\d{0,20}$/;
const cursor = z.string().regex(/^\d{1,24}$/);
export const profileOptions = z
  .strictObject({
    view: z
      .enum(["overview", "posts", "collections", "collection"])
      .default("overview"),
    collectionId: z.string().regex(digits).optional(),
    cursor: cursor.optional(),
    count: z.int().min(1).max(20).default(5),
    details: z.boolean().default(true),
  })
  .refine(
    (o) =>
      (o.view === "collection") === Boolean(o.collectionId) &&
      !(o.view === "overview" && o.cursor),
    "集合编号仅用于 collection；overview 从第一页开始",
  );
type Platform = "bilibili" | "douyin";
interface Profile {
  platform: Platform;
  id: string;
  url: string;
}
export async function identifyProfile(input: string): Promise<Profile> {
  const matches = input.match(/https?:\/\/[^\s，。；<>]+/g);
  if (matches?.length !== 1 || input.length > 4096 || !URL.canParse(matches[0]))
    throw new LensError("INVALID_URL", "请输入一个公开用户主页链接");
  let u = new URL(matches[0]);
  if (u.protocol !== "https:" || u.port || u.username || u.password)
    throw new LensError("UNSAFE_URL", "主页需要使用允许域名的 HTTPS 链接");
  if (
    (u.hostname === "b23.tv" || u.hostname === "v.douyin.com") &&
    /^\/[\w-]+\/?$/.test(u.pathname)
  ) {
    u.search = "";
    u.hash = "";
    const r = await fetchPublic(
      u.href,
      u.hostname === "b23.tv" ? "bili-profile" : "dy-profile",
      AbortSignal.timeout(12000),
    );
    r.res.destroy();
    u = r.url;
  }
  let id: string | undefined;
  if (u.hostname === "space.bilibili.com")
    id = /^\/([1-9]\d{0,19})(?:\/(?:upload\/video|video|lists))?\/?$/.exec(
      u.pathname,
    )?.[1];
  if (u.hostname === "m.bilibili.com")
    id = /^\/space\/([1-9]\d{0,19})\/?$/.exec(u.pathname)?.[1];
  if (id)
    return {
      platform: "bilibili",
      id,
      url: "https://space.bilibili.com/" + id,
    };
  if (
    ["www.douyin.com", "douyin.com", "www.iesdouyin.com"].includes(u.hostname)
  )
    id = /^\/(?:share\/)?user\/(MS4wLj[A-Za-z0-9_-]{10,180})\/?$/.exec(
      u.pathname,
    )?.[1];
  if (id)
    return { platform: "douyin", id, url: "https://www.douyin.com/user/" + id };
  throw new LensError("INVALID_PROFILE", "未识别到公开 B 站空间或抖音作者主页");
}
const countValue = z.int().nullish();
const metrics = z.object({
  play_count: countValue,
  digg_count: countValue,
  comment_count: countValue,
  collect_count: countValue,
  share_count: countValue,
});
const row = z.object({
  platform: z.enum(["douyin", "bilibili"]),
  content_id: z.string(),
  kind: z.string(),
  title: z.string(),
  author: z.object({ uid: z.string(), nickname: z.string() }),
  is_private: z.boolean(),
  is_deleted: z.boolean(),
  created_at: z.iso.datetime({ offset: true }).nullable(),
  fetched_at: z.iso.datetime({ offset: true }),
  duration_ms: z.number().nonnegative().nullable(),
  stats: metrics,
});
const pageFields = { cursor: cursor.nullish(), has_more: z.boolean() };
const postsPage = z.object({ ...pageFields, items: z.array(row) });
const mixesPage = z.object({
  ...pageFields,
  items: z.array(
    z.object({
      platform: z.string(),
      mix_id: z.string().regex(digits),
      owner_id: z.string().nullable(),
      name: z.string(),
      item_count: countValue,
    }),
  ),
});
function nextCursor(
  page: { cursor?: string | null; has_more: boolean },
  current?: string,
) {
  if (page.has_more && (!page.cursor || page.cursor === current))
    throw new LensError("PROVIDER_PROTOCOL", "上游未提供可前进的分页游标");
  return page.has_more ? page.cursor! : null;
}
function counts(s: z.infer<typeof metrics>) {
  const n = (v: number | null | undefined) => (v != null && v >= 0 ? v : null);
  return {
    likes: n(s.digg_count),
    views: n(s.play_count),
    comments: n(s.comment_count),
    favorites: n(s.collect_count),
    shares: n(s.share_count),
  };
}
function post(p: Profile, r: z.infer<typeof row>) {
  const bili = p.platform === "bilibili";
  if (
    r.platform !== p.platform ||
    r.author.uid !== p.id ||
    r.is_private ||
    r.is_deleted ||
    !(bili ? /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/ : /^\d{8,21}$/).test(
      r.content_id,
    ) ||
    !(r.kind === "video" || (!bili && r.kind === "image_album"))
  )
    return null;
  const url = bili
    ? "https://www.bilibili.com/video/" + r.content_id + "/"
    : "https://www.douyin.com/" +
      (r.kind === "image_album" ? "note/" : "video/") +
      r.content_id;
  return {
    id: r.content_id,
    title: r.title,
    url,
    kind: r.kind,
    author: r.author.nickname,
    publishedAt: r.created_at,
    duration: r.duration_ms === null ? null : r.duration_ms / 1000,
    stats: counts(r.stats),
    statsAt: r.fetched_at,
    statsError: null as string | null,
  };
}
interface Collection {
  id: string;
  name: string;
  count: number | null;
}
type Item = NonNullable<ReturnType<typeof post>>;
export async function listProfile(
  c: Config,
  input: string,
  options: z.input<typeof profileOptions> = {},
  query = queryProvider,
) {
  const o = profileOptions.parse(options),
    p = await identifyProfile(input);
  if (c.provider !== "evil0ctal")
    throw new LensError("NATIVE_UNSUPPORTED", "主页作品目录需要 Evil0ctal");
  const params: Record<string, string> = { count: String(o.count) };
  if (o.cursor) params.cursor = o.cursor;
  const args = { ...params, sec_user_id: p.id };
  async function catalog() {
    const result = mixesPage.parse(
      await query(c, p.platform, "user/mixes", args),
    );
    return {
      items: result.items
        .filter((m) => m.owner_id === p.id && m.platform === p.platform)
        .map((m) => ({
          id: m.mix_id,
          name: m.name,
          count: m.item_count ?? null,
        })),
      next: nextCursor(result, o.cursor),
    };
  }
  async function works(collectionId?: string) {
    const whole = Boolean(collectionId) && p.platform === "bilibili";
    const source = collectionId
      ? await query(
          c,
          p.platform,
          "mix/posts",
          whole
            ? { mix_id: collectionId }
            : { ...params, mix_id: collectionId },
        )
      : await query(c, p.platform, "user/posts", args);
    const result = postsPage.parse(source);
    const all = new Map<string, Item>();
    for (const raw of result.items) {
      const item = post(p, raw);
      if (item) all.set(item.id, item);
    }
    const offset = whole ? Number(o.cursor ?? 0) : 0;
    const values = [...all.values()];
    const items = whole ? values.slice(offset, offset + o.count) : values;
    const next = whole
      ? offset + items.length < values.length
        ? String(offset + items.length)
        : null
      : nextCursor(result, o.cursor);
    return { items, next };
  }
  let view = o.view === "overview" ? "posts" : o.view;
  let collectionId = o.collectionId,
    collections: Collection[] = [],
    collectionCursor: string | null = null;
  let postListError: string | null = null,
    collectionListError: string | null = null;
  let items: Item[] = [],
    next: string | null = null;
  if (o.view === "overview") {
    // A space exposes independent resources. A collection is always labelled
    // separately, even if its entries cover every publicly visible post.
    // A single guest can serve both reads in sequence.
    const [uploads] = await Promise.allSettled([works()]);
    const [mixes] = await Promise.allSettled([catalog()]);
    if (mixes.status === "fulfilled") {
      collections = mixes.value.items;
      collectionCursor = mixes.value.next;
    } else collectionListError = failure(mixes.reason).code;
    if (uploads.status === "fulfilled") ({ items, next } = uploads.value);
    else {
      postListError = failure(uploads.reason).code;
      if (
        ![
          "UPSTREAM_RISK_CONTROL",
          "IDENTITY_LOGIN_REQUIRED",
          "MEDIA_WITHHELD",
        ].includes(postListError) ||
        mixes.status === "rejected"
      )
        throw uploads.reason;
      view = collections.length ? "collection" : "collections";
      collectionId = collections[0]?.id;
      if (collectionId) ({ items, next } = await works(collectionId));
    }
  } else if (view === "collections") {
    const list = await catalog();
    collections = list.items;
    collectionCursor = list.next;
  } else ({ items, next } = await works(collectionId));
  if (o.details) {
    const withdrawn = new Set<string>();
    for (const item of items) {
      if (item.stats.likes !== null) continue;
      try {
        const raw = await query(c, p.platform, "video", { url: item.url });
        const detail = post(p, row.parse(raw));
        if (!detail || detail.id !== item.id) {
          withdrawn.add(item.id);
          continue;
        }
        for (const key of Object.keys(item.stats) as (keyof Item["stats"])[])
          item.stats[key] = detail.stats[key] ?? item.stats[key];
        item.statsAt = detail.statsAt;
      } catch (e) {
        const code = failure(e).code;
        if (["CONTENT_PRIVATE", "NOT_FOUND"].includes(code)) {
          withdrawn.add(item.id);
          continue;
        }
        item.statsError = code;
        if (
          [
            "RATE_LIMITED",
            "UPSTREAM_RISK_CONTROL",
            "IDENTITY_POOL_EXHAUSTED",
            "PROVIDER_AUTH",
            "PROVIDER_CONNECTION",
          ].includes(code)
        ) {
          for (const rest of items.slice(items.indexOf(item) + 1))
            if (rest.stats.likes === null) rest.statsError = "NOT_REQUESTED";
          break;
        }
      }
    }
    items = items.filter((item) => !withdrawn.has(item.id));
  }
  return {
    profile: p,
    view,
    collectionId: collectionId ?? null,
    items,
    nextCursor: next,
    collections,
    collectionCursor,
    postListError,
    collectionListError,
    observedAt: new Date().toISOString(),
  };
}
