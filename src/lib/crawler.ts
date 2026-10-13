import type { BrowserContext, Page } from "playwright";
import type { AssetMap } from "./assetMap";
import { BlockedError, newScrapeContext, renderAndExtract, toImageRecords, waitForChallenge } from "./browser";
import type { RawImage } from "./extractor";
import { CONCURRENCY_LIMITS, MAX_PAGES_LIMIT, type CrawlMode, type StreamEvent } from "./types";

export { CONCURRENCY_LIMITS, MAX_PAGES_LIMIT };

export interface CrawlOptions {
  mode: CrawlMode;
  concurrency: number;
  maxPages?: number;
  signal?: AbortSignal;
  /** When provided, every image gets an "EDS image path" looked up from this asset map. */
  assetMap?: AssetMap;
  /** Crawl exactly these page URLs instead of reading them from the sitemap. */
  urls?: string[];
}

const MAX_ATTEMPTS = 4;
/** Attempts per page inside each end-of-crawl retry round (the round cooldown is the main back-off). */
const RETRY_ROUND_ATTEMPTS = 2;
const FINAL_RETRY_ROUNDS = 2;
const FINAL_RETRY_COOLDOWN_MS = Number(process.env.CRAWL_RETRY_COOLDOWN_MS) || 20_000;

/** Server-side hiccup (5xx, 408) worth retrying later. */
class TransientError extends Error {}

const TRANSIENT_NETWORK_ERROR =
  /timeout|ERR_TIMED_OUT|ERR_CONNECTION_(RESET|CLOSED|REFUSED|ABORTED|TIMED_OUT)|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_HTTP2|ERR_SOCKET/i;

function isRetryable(err: unknown): boolean {
  if (err instanceof BlockedError || err instanceof TransientError) return true;
  return err instanceof Error && TRANSIENT_NETWORK_ERROR.test(err.message);
}

type FetchExtractResult =
  | { kind: "ok"; finalUrl: string; title: string; images: RawImage[] }
  | { kind: "http-error"; status: number }
  | { kind: "skipped"; reason: string }
  | { kind: "rate-limited" }
  | { kind: "challenge" }
  | { kind: "fallback"; reason: string };

/** Shared back-off: when the site rate-limits one worker, every worker pauses. */
class Throttle {
  private pauseUntil = 0;
  private strikes = 0;

  async wait(signal?: AbortSignal) {
    while (!signal?.aborted && Date.now() < this.pauseUntil) {
      await sleep(Math.min(500, this.pauseUntil - Date.now()));
    }
  }

  /** Registers a block and returns how long workers will pause. */
  hit(): number {
    const now = Date.now();
    if (now < this.pauseUntil) return this.pauseUntil - now;
    this.strikes++;
    const backoff = Math.min(30_000, 5_000 * 2 ** Math.min(this.strikes - 1, 3));
    this.pauseUntil = now + backoff;
    return backoff;
  }

  ok() {
    if (this.strikes > 0 && Date.now() >= this.pauseUntil) this.strikes--;
  }

  reset() {
    this.strikes = 0;
    this.pauseUntil = 0;
  }
}

/**
 * Runs fetch() inside a real browser tab on the target origin. Requests then use Chromium's
 * TLS fingerprint and Cloudflare cookies, which Node's own HTTP client can't reproduce.
 */
class OriginFetcher {
  private pages = new Map<string, Promise<Page>>();

  constructor(private context: BrowserContext) {}

  pageFor(url: string): Promise<Page> {
    const origin = new URL(url).origin;
    let page = this.pages.get(origin);
    if (!page) {
      page = (async () => {
        const p = await this.context.newPage();
        await p.goto(`${origin}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await waitForChallenge(p);
        return p;
      })();
      this.pages.set(origin, page);
    }
    return page;
  }

  async fetchText(url: string): Promise<{ status: number; text: string }> {
    const page = await this.pageFor(url);
    const run = () =>
      page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: "include", signal: AbortSignal.timeout(60_000) });
          const type = res.headers.get("content-type") || "";
          let text: string;
          if (/\.gz($|\?)/i.test(u) && res.body && !/xml|text/i.test(type)) {
            text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
          } else {
            text = await res.text();
          }
          return { status: res.status, text };
        } catch (e) {
          return { status: 0, text: String(e) };
        }
      }, url);

    let result = await run();
    if (result.status === 403 || result.status === 503) {
      // Possibly challenged: navigate there so the browser solves it, then retry with fresh cookies.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await waitForChallenge(page);
      result = await run();
    }
    return result;
  }

  async fetchAndExtract(url: string): Promise<FetchExtractResult> {
    const page = await this.pageFor(url);
    return page.evaluate(async (u): Promise<FetchExtractResult> => {
      try {
        const res = await fetch(u, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30_000) });
        if (res.status === 429) return { kind: "rate-limited" };
        if (res.headers.get("cf-mitigated") === "challenge") return { kind: "challenge" };
        if (!res.ok) {
          if (res.status === 403 || res.status === 503) return { kind: "challenge" };
          return { kind: "http-error", status: res.status };
        }
        const type = res.headers.get("content-type") || "";
        if (type && !/text\/html|application\/xhtml/i.test(type)) return { kind: "skipped", reason: type.split(";")[0] };
        const html = await res.text();
        if (/<title>\s*just a moment/i.test(html)) return { kind: "challenge" };
        const doc = new DOMParser().parseFromString(html, "text/html");
        let base = res.url || u;
        const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
        if (baseHref) {
          try {
            base = new URL(baseHref, base).href;
          } catch {
            // keep response URL
          }
        }
        const extract = (globalThis as unknown as { __extractImages: (d: Document, b: string) => RawImage[] })
          .__extractImages;
        return { kind: "ok", finalUrl: res.url || u, title: (doc.title || "").trim(), images: extract(doc, base) };
      } catch (e) {
        return { kind: "fallback", reason: String(e) };
      }
    }, url);
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

export function parseSitemap(xml: string): { isIndex: boolean; locs: string[] } {
  // Only unprefixed <loc>, so <image:loc>/<video:loc> entries aren't mistaken for pages.
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)]
    .map((m) => decodeXmlEntities(m[1].trim()))
    .filter((u) => /^https?:\/\//i.test(u));
  return { isIndex: /<sitemapindex[\s>]/i.test(xml), locs };
}

async function collectSitemapUrls(rootUrl: string, fetcher: OriginFetcher, limit: number, signal?: AbortSignal) {
  const pageUrls = new Set<string>();
  const seen = new Set<string>();
  let level = [rootUrl];

  while (level.length && pageUrls.size < limit && !signal?.aborted) {
    const next: string[] = [];
    const results = await Promise.all(
      level.filter((u) => !seen.has(u)).map(async (u) => {
        seen.add(u);
        return { url: u, ...(await fetcher.fetchText(u)) };
      }),
    );
    for (const { url, status, text } of results) {
      if (status < 200 || status >= 400) {
        if (url === rootUrl) throw new Error(`Could not load sitemap (${status ? `HTTP ${status}` : text})`);
        continue;
      }
      const { isIndex, locs } = parseSitemap(text);
      if (isIndex) {
        next.push(...locs);
      } else {
        for (const loc of locs) {
          if (pageUrls.size >= limit) break;
          pageUrls.add(loc);
        }
      }
    }
    level = next;
  }

  if (pageUrls.size === 0) throw new Error("No page URLs found in the sitemap");
  return [...pageUrls];
}

export async function runPool<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: T, workerId: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async (_, workerId) => {
      while (!signal?.aborted && next < items.length) {
        const item = items[next++];
        await worker(item, workerId);
      }
    }),
  );
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Crawls every page listed in a sitemap (sitemap indexes and .gz supported), emitting progress events. */
export async function crawlSitemap(sitemapUrl: string, opts: CrawlOptions, onEvent: (event: StreamEvent) => void) {
  const { assetMap } = opts;
  const emit = (event: StreamEvent) => {
    if (event.type === "page-done" && assetMap) assetMap.enrich(event.images);
    onEvent(event);
  };
  const started = Date.now();
  const limits = CONCURRENCY_LIMITS[opts.mode];
  const concurrency = Math.max(1, Math.min(limits.max, Math.floor(opts.concurrency) || limits.default));
  const maxPages = Math.max(1, Math.min(MAX_PAGES_LIMIT, Math.floor(opts.maxPages ?? MAX_PAGES_LIMIT)));
  const { signal } = opts;

  const context = await newScrapeContext({ blockResources: opts.mode === "render" });
  const onAbort = () => void context.close().catch(() => {});
  signal?.addEventListener("abort", onAbort);

  try {
    const fetcher = new OriginFetcher(context);
    const urls = opts.urls?.length ? opts.urls.slice(0, maxPages) : await collectSitemapUrls(sitemapUrl, fetcher, maxPages, signal);
    emit({ type: "sitemap", sitemapUrl, total: urls.length, urls });

    const renderPages = new Map<number, Page>();
    const renderPageFor = async (workerId: number) => {
      let page = renderPages.get(workerId);
      if (!page || page.isClosed()) {
        page = await context.newPage();
        renderPages.set(workerId, page);
      }
      return page;
    };

    const throttle = new Throttle();

    const attempt = async (url: string, workerId: number): Promise<StreamEvent> => {
      const t0 = Date.now();
      if (opts.mode === "fast") {
        const result = await fetcher.fetchAndExtract(url);
        switch (result.kind) {
          case "ok":
            return { type: "page-done", url, title: result.title, images: toImageRecords(url, result.images), via: "fetch", ms: Date.now() - t0 };
          case "skipped":
            return { type: "page-skipped", url, reason: `Not HTML (${result.reason})` };
          case "http-error":
            if (result.status >= 500 || result.status === 408) throw new TransientError(`HTTP ${result.status}`);
            return { type: "page-error", url, message: `HTTP ${result.status}` };
          case "rate-limited":
            throw new BlockedError("Rate limited by the site (HTTP 429)", true);
          // "challenge" / "fallback": a real browser render may get through.
        }
      }

      const page = await renderPageFor(workerId);
      try {
        const { title, images } = await renderAndExtract(page, url, { idleTimeoutMs: 5_000, scrollDelayMs: 60 });
        return { type: "page-done", url, title, images: toImageRecords(url, images), via: "render", ms: Date.now() - t0 };
      } catch (err) {
        // A failed navigation can leave the tab in a bad state; replace it for the next URL.
        await page.close().catch(() => {});
        renderPages.delete(workerId);
        throw err;
      }
    };

    const deferred = new Map<string, string>();

    /** Tries a URL (with in-place retries while rate-limited). Emits a final event unless the failure is retryable. */
    const processUrl = async (
      url: string,
      workerId: number,
      maxAttempts: number,
    ): Promise<{ retryable: false } | { retryable: true; message: string }> => {
      for (let n = 1; ; n++) {
        await throttle.wait(signal);
        if (signal?.aborted) return { retryable: false };
        try {
          const event = await attempt(url, workerId);
          throttle.ok();
          emit(event);
          return { retryable: false };
        } catch (err) {
          if (signal?.aborted) return { retryable: false };
          if (err instanceof BlockedError && n < maxAttempts) {
            emit({ type: "throttled", url, waitMs: throttle.hit(), message: err.message });
            continue;
          }
          if (isRetryable(err)) return { retryable: true, message: friendlyError(err) };
          emit({ type: "page-error", url, message: friendlyError(err) });
          return { retryable: false };
        }
      }
    };

    await runPool(urls, concurrency, signal, async (url, workerId) => {
      const outcome = await processUrl(url, workerId, MAX_ATTEMPTS);
      if (outcome.retryable) {
        deferred.set(url, outcome.message);
        emit({ type: "page-deferred", url, message: outcome.message });
      }
    });

    // Rate-limited / transient failures get more chances after the main pass, once the site has
    // cooled down, with far fewer parallel workers.
    const retryConcurrency = Math.max(1, Math.ceil(concurrency / 4));
    for (let round = 1; round <= FINAL_RETRY_ROUNDS && deferred.size > 0 && !signal?.aborted; round++) {
      const retryUrls = [...deferred.keys()];
      const waitMs = FINAL_RETRY_COOLDOWN_MS * round;
      emit({ type: "retry-round", round, totalRounds: FINAL_RETRY_ROUNDS, count: retryUrls.length, waitMs });
      await sleep(waitMs, signal);
      throttle.reset();
      const lastRound = round === FINAL_RETRY_ROUNDS;
      await runPool(retryUrls, retryConcurrency, signal, async (url, workerId) => {
        const outcome = await processUrl(url, workerId, RETRY_ROUND_ATTEMPTS);
        if (!outcome.retryable) {
          deferred.delete(url);
        } else if (lastRound) {
          deferred.delete(url);
          emit({ type: "page-error", url, message: `${outcome.message} (gave up after ${FINAL_RETRY_ROUNDS} retry rounds)` });
        } else {
          deferred.set(url, outcome.message);
        }
      });
    }

    emit({ type: "done", elapsedMs: Date.now() - started });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await context.close().catch(() => {});
  }
}

export function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Drop Playwright's verbose "Call log" section and ANSI colour codes.
  return message
    .split("\nCall log:")[0]
    .replace(/\u001b\[\d+m/g, "")
    .replace(/^page\.\w+:\s*/, "")
    .trim();
}
