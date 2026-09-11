/**
 * Assistant "superpowers": look things up in the outside world – X/Twitter, YouTube, TikTok, Google, any URL.
 *
 * Provider policy (same as content-ai): the DIRECT vendor key is used when present (twitterapi.io, transcriptapi.com),
 * monid.ai is primary for web search / page reads, and treg.to's routed catalog is the fallback for everything.
 * Every call is folded into a compact provider-agnostic `SocialItem[]`, recorded in `social_lookups` (who asked, what
 * it cost, what came back) and reused for SOCIAL_CACHE_MINUTES so the same question doesn't bill twice.
 *
 * Verified shapes (2026-09-10):
 *   twitterapi   GET /twitter/tweet/advanced_search?query&queryType → { tweets: [{ id, url, text, createdAt, likeCount, retweetCount, replyCount, viewCount, author: { userName, name } }] }
 *   twitterapi   GET /twitter/user/last_tweets?userName            → { data: { tweets: [...] } } | { tweets }
 *   transcriptapi GET /youtube/search?q&limit                       → { results: [{ videoId, title, channelTitle, channelHandle, lengthText, viewCountText, publishedTimeText }] }
 *   transcriptapi GET /youtube/transcript?video_url                 → { transcript | text | segments: [{ text }] }
 *   monid  context.dev /web/search { query, numResults, country }   → { results: [{ url, title, description, relevance }] }
 *   monid  context.dev /web/scrape/markdown ?url                    → { markdown, metadata: { title } } (read defensively)
 *   treg   treg.x.search.posts POST {q}                             → { output: { posts: [tikhub: { tweet_id, screen_name, text, created_at, favorites, retweets, replies, views }] } }
 *   treg   treg.youtube.search.videos POST {q}                      → { output: { videos: [{ video_id, title, author, number_of_views, video_length, published_time, description }] } }
 *   treg   treg.google.serp.organic POST {q, country, language, limit} → { output: { results: [{ title, description, url, domain }] } }
 *   tikhub /api/v1/tiktok/app/v3/fetch_video_search_result          → data.search_item_list[].aweme_info { aweme_id, desc, statistics, share_url, author }
 */
import { env } from "../env";
import { AppError, isAppError } from "../errors";
import { getLogger, errInfo } from "../logger";
import type { SocialItem, SocialKind } from "../db/schema";
import { findRecentSocialLookup, insertSocialLookup } from "../store";
import { monidEnabled, monidRun } from "./monid";
import { tregCall, tregEnabled } from "./treg";

const log = getLogger("social");

export type { SocialItem, SocialKind };
export type LookupResult = { kind: SocialKind; query: string; items: SocialItem[]; provider: string; endpoint: string; costUsd: number; latencyMs: number; cached: boolean };
type ProviderResult = { items: SocialItem[]; provider: string; endpoint: string; costUsd: number; latencyMs: number };
type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^[\d,.]+$/.test(v)) return Number(v.replace(/,/g, "")) || undefined;
  return undefined;
};
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const metrics = (entries: [string, number | undefined][]) => {
  const m = Object.fromEntries(entries.filter((e): e is [string, number] => e[1] != null));
  return Object.keys(m).length ? m : undefined;
};
const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const SOCIAL_KINDS: SocialKind[] = ["tweets", "user_tweets", "youtube", "youtube_transcript", "web", "url", "tiktok"];

/** Which kinds can be served with the current env (for /api/health and the assistant's tool list). */
export function socialCapabilities(): Record<SocialKind, boolean> {
  const e = env();
  const tw = Boolean(e.TWITTERAPI_IO_API_KEY);
  const ta = Boolean(e.TRANSCRIPTAPI_API_KEY);
  const mo = monidEnabled();
  const tr = tregEnabled();
  return { tweets: tw || tr, user_tweets: tw, youtube: ta || tr, youtube_transcript: ta, web: mo || tr, url: true, tiktok: mo || tr };
}

// ── direct vendor clients ────────────────────────────────────────────────────

async function vendorGet(name: string, base: string, path: string, headers: Record<string, string>): Promise<{ data: Raw; latencyMs: number }> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}${path}`, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new AppError(502, `${name}_network_error`, `Could not reach ${name}: ${errInfo(err).message}`, { hint: "Check outbound network access from the server.", cause: err });
  }
  const raw = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? `The ${name} API key is invalid or out of credits.` : res.status === 429 ? `Rate limited by ${name}; retry later.` : `Inspect \`data\` for the raw ${name} response.`;
    log.error({ status: res.status, name, path: path.slice(0, 120), body: raw.slice(0, 400), hint }, "vendor returned an error");
    throw new AppError(502, `${name}_upstream_error`, `${name} responded ${res.status}`, { hint, data: raw.slice(0, 400) });
  }
  try {
    return { data: JSON.parse(raw) as Raw, latencyMs: Date.now() - t0 };
  } catch {
    return { data: { text: raw }, latencyMs: Date.now() - t0 };
  }
}

function foldTwitterApiTweet(t: Raw): SocialItem | undefined {
  const id = str(t.id) ?? str(t.id_str);
  const text = str(t.text) ?? str(t.full_text);
  if (!id || !text) return undefined;
  const a = obj(t.author);
  const handle = str(a.userName) ?? str(a.screen_name);
  return {
    id,
    text: clip(text, 500),
    url: str(t.url) ?? (handle ? `https://x.com/${handle}/status/${id}` : undefined),
    author: handle ? `@${handle}${str(a.name) ? ` (${a.name})` : ""}` : undefined,
    date: str(t.createdAt) ?? str(t.created_at),
    metrics: metrics([["likes", num(t.likeCount)], ["retweets", num(t.retweetCount)], ["replies", num(t.replyCount)], ["views", num(t.viewCount)]]),
  };
}

/** twitterapi.io keyword search (Top or Latest). ~$0.15 / 1k tweets, min $0.00015. */
async function twitterSearch(query: string, opts: { latest?: boolean; limit: number }): Promise<ProviderResult> {
  const e = env();
  const { data, latencyMs } = await vendorGet("twitterapi", e.TWITTERAPI_IO_BASE_URL, `/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=${opts.latest ? "Latest" : "Top"}`, { "x-api-key": e.TWITTERAPI_IO_API_KEY! });
  const rows = arr(data.tweets).length ? arr(data.tweets) : arr(obj(data.data).tweets);
  const items = rows.map(foldTwitterApiTweet).filter((x): x is SocialItem => Boolean(x)).slice(0, opts.limit);
  return { items, provider: "twitterapi", endpoint: "/twitter/tweet/advanced_search", costUsd: Math.max(0.00015, (rows.length / 1000) * 0.15), latencyMs };
}

/** twitterapi.io: latest tweets of one account (retweets dropped). */
async function twitterUserTweets(handle: string, limit: number): Promise<ProviderResult> {
  const e = env();
  const h = handle.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/[/?#].*$/, "");
  const { data, latencyMs } = await vendorGet("twitterapi", e.TWITTERAPI_IO_BASE_URL, `/twitter/user/last_tweets?userName=${encodeURIComponent(h)}`, { "x-api-key": e.TWITTERAPI_IO_API_KEY! });
  const rows = arr(obj(data.data).tweets).length ? arr(obj(data.data).tweets) : arr(data.tweets);
  const items = rows
    .filter((t) => !(t.retweeted_tweet != null || t.isRetweet === true || /^RT @/.test(str(t.text) ?? "")))
    .map(foldTwitterApiTweet)
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
  if (!items.length && !rows.length) throw new AppError(404, "twitter_user_not_found", `No tweets found for @${h}`, { hint: "Check the handle (no spaces) – the account may be private, suspended or misspelt." });
  return { items, provider: "twitterapi", endpoint: "/twitter/user/last_tweets", costUsd: Math.max(0.00015, (rows.length / 1000) * 0.15), latencyMs };
}

/** treg routed X search (served by TikHub / JustOneAPI). */
async function tregTwitterSearch(query: string, limit: number): Promise<ProviderResult> {
  const r = await tregCall("treg.x.search.posts", { body: { q: query } });
  const rows = arr(obj(r.output.output).posts);
  const items = rows
    .map((t): SocialItem | undefined => {
      const id = str(t.tweet_id) ?? str(t.id) ?? str(t.id_str);
      const text = str(t.text) ?? str(t.full_text);
      if (!id || !text) return undefined;
      const handle = str(t.screen_name) ?? str(obj(t.user).screen_name) ?? str(obj(t.author).userName);
      return {
        id,
        text: clip(text, 500),
        url: handle ? `https://x.com/${handle}/status/${id}` : undefined,
        author: handle ? `@${handle}` : undefined,
        date: str(t.created_at) ?? str(t.createdAt),
        metrics: metrics([["likes", num(t.favorites) ?? num(t.likeCount)], ["retweets", num(t.retweets) ?? num(t.retweetCount)], ["replies", num(t.replies) ?? num(t.replyCount)], ["views", num(t.views) ?? num(t.viewCount)]]),
      };
    })
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
  return { items, provider: "treg", endpoint: `treg.x.search.posts${r.servedBy ? ` (${r.servedBy})` : ""}`, costUsd: r.costUsd, latencyMs: r.latencyMs };
}

/** transcriptapi.com YouTube search – free. */
async function transcriptApiSearch(query: string, limit: number): Promise<ProviderResult> {
  const e = env();
  const { data, latencyMs } = await vendorGet("transcriptapi", e.TRANSCRIPTAPI_BASE_URL, `/youtube/search?q=${encodeURIComponent(query)}&limit=${limit}`, { Authorization: `Bearer ${e.TRANSCRIPTAPI_API_KEY}` });
  const items = arr(data.results)
    .map((v): SocialItem | undefined => {
      const id = str(v.videoId);
      if (!id) return undefined;
      return {
        id,
        title: str(v.title),
        url: `https://youtube.com/watch?v=${id}`,
        author: str(v.channelHandle) ?? str(v.channelTitle),
        date: str(v.publishedTimeText),
        text: [str(v.lengthText) && `duración ${v.lengthText}`, str(v.viewCountText)].filter(Boolean).join(" · ") || undefined,
        metrics: metrics([["views", num(String(v.viewCountText ?? "").replace(/[^\d,.]/g, ""))]]),
      };
    })
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
  return { items, provider: "transcriptapi", endpoint: "/youtube/search", costUsd: 0, latencyMs };
}

/** treg routed YouTube search (served by TikHub / JustOneAPI / SerpApi). */
async function tregYoutubeSearch(query: string, limit: number): Promise<ProviderResult> {
  const r = await tregCall("treg.youtube.search.videos", { body: { q: query } });
  const items = arr(obj(r.output.output).videos)
    .map((v): SocialItem | undefined => {
      const id = str(v.video_id) ?? str(v.videoId) ?? str(v.id);
      if (!id) return undefined;
      return {
        id,
        title: str(v.title),
        url: str(v.link) ?? `https://youtube.com/watch?v=${id}`,
        author: str(v.author) ?? str(v.channel) ?? str(obj(v.channel).name),
        date: str(v.published_time) ?? str(v.publishedTime),
        text: clip([str(v.video_length) && `duración ${v.video_length}`, str(v.description)].filter(Boolean).join(" · ") || undefined, 300),
        metrics: metrics([["views", num(v.number_of_views) ?? num(v.views)]]),
      };
    })
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
  return { items, provider: "treg", endpoint: `treg.youtube.search.videos${r.servedBy ? ` (${r.servedBy})` : ""}`, costUsd: r.costUsd, latencyMs: r.latencyMs };
}

/** YouTube watch / short / youtu.be URL (or bare id) → video id. */
export function youtubeVideoId(input: string): string | undefined {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.split("/").filter(Boolean)[0] ?? null;
    else if (host === "youtube.com") id = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)?.[1] ?? null;
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

const TRANSCRIPT_MAX_CHARS = 14_000;

/** transcriptapi.com transcript – 1 credit per video (billed only on 200). Plus free oEmbed for the title. */
async function transcriptApiTranscript(input: string): Promise<ProviderResult> {
  const e = env();
  const id = youtubeVideoId(input);
  if (!id) throw AppError.badRequest(`"${input}" is not a YouTube URL`, "Pass a youtube.com/watch?v=… , youtu.be/… or shorts URL.");
  const url = `https://youtube.com/watch?v=${id}`;
  let title: string | undefined;
  let author: string | undefined;
  try {
    const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (o.ok) {
      const j = (await o.json()) as Raw;
      title = str(j.title);
      author = str(j.author_name);
    }
  } catch {
    /* title is optional */
  }
  // A fresh upload has no captions for a few hours: transcriptapi answers 408 (their fetch times out) or 404.
  // One retry covers the transient case; then tell the model plainly so it can fall back to the title/description.
  const fetchTranscript = () => vendorGet("transcriptapi", e.TRANSCRIPTAPI_BASE_URL, `/youtube/transcript?video_url=${encodeURIComponent(url)}`, { Authorization: `Bearer ${e.TRANSCRIPTAPI_API_KEY}` });
  let got: Awaited<ReturnType<typeof fetchTranscript>>;
  try {
    got = await fetchTranscript().catch(async (err) => {
      if (isAppError(err) && /responded (408|5\d\d)/.test(err.message)) return fetchTranscript();
      throw err;
    });
  } catch (err) {
    if (isAppError(err) && /responded (404|408|422)/.test(err.message)) {
      throw new AppError(404, "no_transcript", `No transcript available for ${title ? `"${title}"` : url}${/408/.test(err.message) ? " (captions not ready yet – new videos take a few hours)" : ""}.`, { hint: "Summarise from the title/description or pick an older video.", cause: err });
    }
    throw err;
  }
  const { data, latencyMs } = got;
  const t = data.transcript ?? data.text ?? data.content;
  let text: string | undefined = typeof t === "string" ? t : undefined;
  if (!text) {
    const segs = arr(data.segments).length ? arr(data.segments) : arr(data.transcript).length ? arr(data.transcript) : arr(obj(data.data).segments);
    text = segs.map((s) => str(s.text) ?? "").join(" ").replace(/\s+/g, " ").trim() || undefined;
  }
  if (!text) throw new AppError(404, "no_transcript", "This video has no captions/transcript.", { hint: "Try a different video or ask for the description instead." });
  return { items: [{ id, title, url, author, text: clip(text, TRANSCRIPT_MAX_CHARS) }], provider: "transcriptapi", endpoint: "/youtube/transcript", costUsd: 0, latencyMs };
}

/** monid → context.dev web search (Google-style operators OK). ~$0.0009 per 10 results. */
async function monidWebSearch(query: string, limit: number): Promise<ProviderResult> {
  const e = env();
  const r = await monidRun("context.dev", "/web/search", { body: { query, numResults: 10, country: e.SOCIAL_COUNTRY.toLowerCase() } });
  const items = arr(r.output.results)
    .map((x): SocialItem | undefined => {
      const url = str(x.url);
      if (!url) return undefined;
      return { url, title: str(x.title), text: clip(str(x.description) ?? str(x.snippet), 300) };
    })
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
  return { items, provider: "monid", endpoint: "context.dev /web/search", costUsd: r.costUsd, latencyMs: r.latencyMs };
}

/** treg routed Google organic results (DataForSEO / ScrapeCreators / SerpApi). */
async function tregWebSearch(query: string, limit: number): Promise<ProviderResult> {
  const e = env();
  const r = await tregCall("treg.google.serp.organic", { body: { q: query, country: e.SOCIAL_COUNTRY.toLowerCase(), language: e.BOT_LANGUAGE.slice(0, 2), limit } });
  const items = arr(obj(r.output.output).results)
    .map((x): SocialItem | undefined => {
      const url = str(x.url) ?? str(x.link);
      if (!url) return undefined;
      return { url, title: str(x.title), text: clip(str(x.description) ?? str(x.snippet), 300) };
    })
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
  return { items, provider: "treg", endpoint: `treg.google.serp.organic${r.servedBy ? ` (${r.servedBy})` : ""}`, costUsd: r.costUsd, latencyMs: r.latencyMs };
}

const PAGE_MAX_CHARS = 12_000;

function htmlToText(html: string): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|h\d|li|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return title ? `# ${title}\n${body}` : body;
}

/** Read a page: monid → context.dev Markdown (JS rendering + anti-bot) first, plain fetch as the free fallback. */
async function readUrl(input: string): Promise<ProviderResult> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw AppError.badRequest(`"${input}" is not a URL`, "Pass a full http(s) URL.");
  }
  const yt = youtubeVideoId(url.toString());
  if (yt && env().TRANSCRIPTAPI_API_KEY) return transcriptApiTranscript(url.toString());
  if (monidEnabled()) {
    try {
      const r = await monidRun("context.dev", "/web/scrape/markdown", { queryParams: { url: url.toString(), useMainContentOnly: true, includeImages: false } });
      const o = r.output;
      const md = str(o.markdown) ?? str(o.content) ?? str(o.text) ?? str(obj(o.data).markdown);
      const meta = obj(o.metadata);
      if (md) return { items: [{ url: url.toString(), title: str(meta.title) ?? str(o.title), author: str(meta.author) ?? str(meta.siteName), text: clip(md, PAGE_MAX_CHARS) }], provider: "monid", endpoint: "context.dev /web/scrape/markdown", costUsd: r.costUsd, latencyMs: r.latencyMs };
      log.warn({ url: url.toString(), keys: Object.keys(o), hint: "context.dev answered without markdown; falling back to a plain fetch." }, "monid scrape empty");
    } catch (err) {
      log.warn({ err: errInfo(err), url: url.toString(), hint: "monid scrape failed; falling back to a plain fetch." }, "monid scrape failed");
    }
  }
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new AppError(502, "url_fetch_failed", `Could not fetch ${url.hostname}: ${errInfo(err).message}`, { hint: "The site may be down or blocking bots; set MONID_API_KEY to read pages through context.dev.", cause: err });
  }
  const body = await res.text();
  if (!res.ok) throw new AppError(502, "url_fetch_failed", `${url.hostname} responded ${res.status}`, { hint: res.status === 403 || res.status === 429 ? "Anti-bot wall; set MONID_API_KEY to read pages through context.dev." : "The page is not reachable." });
  const text = htmlToText(body);
  if (!text) throw new AppError(404, "url_empty", "The page has no readable text.", { hint: "JavaScript-only page; set MONID_API_KEY to render it through context.dev." });
  return { items: [{ url: url.toString(), text: clip(text, PAGE_MAX_CHARS) }], provider: "fetch", endpoint: "GET", costUsd: 0, latencyMs: Date.now() - t0 };
}

/** TikHub keyword search → items (rows under search_item_list[].aweme_info). */
function foldTiktok(output: Raw, limit: number): SocialItem[] {
  const root = obj(output.data ?? output);
  const rows = arr(root.search_item_list).length ? arr(root.search_item_list) : arr(root.aweme_list).length ? arr(root.aweme_list) : arr(root.data);
  return rows
    .map((row): SocialItem | undefined => {
      const v = obj(row.aweme_info ?? row.aweme ?? row);
      const id = str(v.aweme_id) ?? str(v.id);
      const desc = str(v.desc) ?? str(v.title);
      if (!id || !desc) return undefined;
      const st = obj(v.statistics);
      const a = obj(v.author);
      return {
        id,
        text: clip(desc, 300),
        url: str(v.share_url) ?? `https://www.tiktok.com/@${str(a.unique_id) ?? "_"}/video/${id}`,
        author: str(a.unique_id) ? `@${a.unique_id}` : str(a.nickname),
        date: typeof v.create_time === "number" ? new Date(v.create_time * 1000).toISOString() : undefined,
        metrics: metrics([["views", num(st.play_count)], ["likes", num(st.digg_count)], ["comments", num(st.comment_count)], ["shares", num(st.share_count)]]),
      };
    })
    .filter((x): x is SocialItem => Boolean(x))
    .slice(0, limit);
}

/** TikTok keyword search, most-liked first: monid primary, treg catalog fallback (same TikHub upstream). */
async function tiktokSearch(query: string, limit: number): Promise<ProviderResult> {
  const e = env();
  const params = { keyword: query, count: Math.min(30, Math.max(limit, 10)), offset: 0, sort_type: 1, publish_time: 0, region: e.SOCIAL_COUNTRY.toUpperCase() };
  let monidErr: unknown;
  if (monidEnabled()) {
    try {
      const r = await monidRun("tikhub", "/api/v1/tiktok/app/v3/fetch_video_search_result", { queryParams: params });
      const items = foldTiktok(r.output, limit);
      if (items.length || !tregEnabled()) return { items, provider: "monid", endpoint: "tikhub fetch_video_search_result", costUsd: r.costUsd, latencyMs: r.latencyMs };
    } catch (err) {
      monidErr = err;
      if (!tregEnabled()) throw err;
    }
  }
  const t = await tregCall("tikhub.tiktok.search.videos", { queryParams: params }).catch((err) => {
    throw monidErr ?? err;
  });
  return { items: foldTiktok(t.output, limit), provider: "treg", endpoint: "tikhub.tiktok.search.videos", costUsd: t.costUsd, latencyMs: t.latencyMs };
}

// ── dispatcher + cache + audit ───────────────────────────────────────────────

async function dispatch(kind: SocialKind, query: string, opts: { limit: number; latest?: boolean }): Promise<ProviderResult> {
  const e = env();
  const notConfigured = (vars: string[]) => AppError.notConfigured(`social lookup "${kind}"`, vars);
  switch (kind) {
    case "tweets":
      if (e.TWITTERAPI_IO_API_KEY) {
        try {
          return await twitterSearch(query, opts);
        } catch (err) {
          if (!tregEnabled()) throw err;
          log.warn({ err: errInfo(err), hint: "twitterapi.io failed; retrying through treg." }, "tweets fallback");
        }
      }
      if (tregEnabled()) return tregTwitterSearch(query, opts.limit);
      throw notConfigured(["TWITTERAPI_IO_API_KEY", "TREG_TOKEN"]);
    case "user_tweets":
      if (!e.TWITTERAPI_IO_API_KEY) throw notConfigured(["TWITTERAPI_IO_API_KEY"]);
      return twitterUserTweets(query, opts.limit);
    case "youtube":
      if (e.TRANSCRIPTAPI_API_KEY) {
        try {
          return await transcriptApiSearch(query, opts.limit);
        } catch (err) {
          if (!tregEnabled()) throw err;
          log.warn({ err: errInfo(err), hint: "transcriptapi failed; retrying through treg." }, "youtube fallback");
        }
      }
      if (tregEnabled()) return tregYoutubeSearch(query, opts.limit);
      throw notConfigured(["TRANSCRIPTAPI_API_KEY", "TREG_TOKEN"]);
    case "youtube_transcript":
      if (!e.TRANSCRIPTAPI_API_KEY) throw notConfigured(["TRANSCRIPTAPI_API_KEY"]);
      return transcriptApiTranscript(query);
    case "web":
      if (monidEnabled()) {
        try {
          return await monidWebSearch(query, opts.limit);
        } catch (err) {
          if (!tregEnabled()) throw err;
          log.warn({ err: errInfo(err), hint: "monid web search failed; retrying through treg." }, "web fallback");
        }
      }
      if (tregEnabled()) return tregWebSearch(query, opts.limit);
      throw notConfigured(["MONID_API_KEY", "TREG_TOKEN"]);
    case "url":
      return readUrl(query);
    case "tiktok":
      if (!monidEnabled() && !tregEnabled()) throw notConfigured(["MONID_API_KEY", "TREG_TOKEN"]);
      return tiktokSearch(query, opts.limit);
    default:
      throw AppError.badRequest(`Unknown lookup kind "${kind}"`, `Use one of: ${SOCIAL_KINDS.join(", ")}`);
  }
}

export function socialQueryKey(kind: SocialKind, query: string) {
  return `${kind}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Look something up. Serves an identical (kind, query) from `social_lookups` when younger than SOCIAL_CACHE_MINUTES,
 * otherwise asks the provider, then records the row (also on failure, with `ok=false` and the error).
 */
export async function socialLookup(kind: SocialKind, query: string, opts: { chatJid?: string; requestedBy?: string; requestedByName?: string; reqId?: string; limit?: number; latest?: boolean; force?: boolean } = {}): Promise<LookupResult> {
  const e = env();
  if (!e.SOCIAL_SEARCH_ENABLED) throw new AppError(503, "social_disabled", "Social / web lookups are disabled.", { hint: "Set SOCIAL_SEARCH_ENABLED=true." });
  const q = query.trim();
  if (!q) throw AppError.badRequest("Empty query", "Pass a keyword, handle or URL.");
  if (!SOCIAL_KINDS.includes(kind)) throw AppError.badRequest(`Unknown lookup kind "${kind}"`, `Use one of: ${SOCIAL_KINDS.join(", ")}`);
  const limit = Math.min(20, Math.max(1, opts.limit ?? 8));
  const queryKey = socialQueryKey(kind, q) + (opts.latest ? ":latest" : "");
  const slog = log.child({ kind, query: q.slice(0, 120), reqId: opts.reqId, chat: opts.chatJid });
  const base = { kind, query: q, queryKey, chatJid: opts.chatJid, requestedBy: opts.requestedBy, requestedByName: opts.requestedByName };

  if (!opts.force && e.SOCIAL_CACHE_MINUTES > 0) {
    const hit = await findRecentSocialLookup(queryKey, new Date(Date.now() - e.SOCIAL_CACHE_MINUTES * 60_000));
    if (hit) {
      const items = (hit.results ?? []).slice(0, limit);
      slog.info({ cacheId: hit.id, ageSec: Math.round((Date.now() - hit.createdAt.getTime()) / 1000), n: items.length }, "social lookup served from cache");
      await insertSocialLookup({ ...base, provider: hit.provider ?? undefined, endpoint: hit.endpoint ?? undefined, ok: true, results: items, costUsd: 0, latencyMs: 0, cached: true }).catch(() => {});
      return { kind, query: q, items, provider: hit.provider ?? "cache", endpoint: hit.endpoint ?? "cache", costUsd: 0, latencyMs: 0, cached: true };
    }
  }

  try {
    const r = await dispatch(kind, q, { limit, latest: opts.latest });
    slog.info({ provider: r.provider, endpoint: r.endpoint, n: r.items.length, costUsd: r.costUsd, ms: r.latencyMs }, "social lookup ok");
    await insertSocialLookup({ ...base, provider: r.provider, endpoint: r.endpoint, ok: true, results: r.items, costUsd: r.costUsd, latencyMs: r.latencyMs }).catch((err) => slog.warn({ err: errInfo(err) }, "could not record social lookup"));
    return { kind, query: q, items: r.items, provider: r.provider, endpoint: r.endpoint, costUsd: r.costUsd, latencyMs: r.latencyMs, cached: false };
  } catch (err) {
    const info = errInfo(err);
    slog.error({ err: info, hint: isAppError(err) ? err.hint : "Provider call threw; see stack." }, "social lookup failed");
    await insertSocialLookup({ ...base, ok: false, error: `${info.message}${isAppError(err) && err.hint ? ` – ${err.hint}` : ""}`.slice(0, 500) }).catch(() => {});
    throw err;
  }
}
