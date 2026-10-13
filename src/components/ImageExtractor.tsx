"use client";

import { useRef, useState } from "react";
import EdsMapper from "./EdsMapper";
import PackageUpdater from "./PackageUpdater";
import AemConfig from "./AemConfig";
import ResultsView, { type PageState } from "./ResultsView";
import { CONCURRENCY_LIMITS, type CrawlMode, type ImageRecord, type StreamEvent } from "@/lib/types";

type Tab = "sitemap" | "pages" | "eds" | "package" | "config";
type RunKind = Exclude<Tab, "eds" | "package" | "config">;

const MODE_DEFAULTS: Record<CrawlMode, { concurrency: number; max: number }> = {
  fast: { concurrency: CONCURRENCY_LIMITS.fast.default, max: CONCURRENCY_LIMITS.fast.max },
  render: { concurrency: CONCURRENCY_LIMITS.render.default, max: CONCURRENCY_LIMITS.render.max },
};

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

async function readNdjson(res: Response, onEvent: (e: StreamEvent) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(ms / 1000).toFixed(1)}s`;
}

export default function ImageExtractor() {
  const [tab, setTab] = useState<Tab>("sitemap");
  const [sitemapUrl, setSitemapUrl] = useState("https://www.abbvie.co.nz/sitemap.xml");
  const [mode, setMode] = useState<CrawlMode>("fast");
  const [concurrency, setConcurrency] = useState(MODE_DEFAULTS.fast.concurrency);
  const [maxPages, setMaxPages] = useState("");
  const [urlInput, setUrlInput] = useState("https://www.abbvie.com/");

  const [runKind, setRunKind] = useState<RunKind>("sitemap");
  const [pages, setPages] = useState<Map<string, PageState>>(new Map());
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [throttledUntil, setThrottledUntil] = useState(0);
  const [now, setNow] = useState(0);
  const [retryRound, setRetryRound] = useState<{ round: number; totalRounds: number; count: number; startsAt: number } | null>(null);
  const [assetMapInfo, setAssetMapInfo] = useState<{ file: string | null; assets: number; error?: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pagesRef = useRef<Map<string, PageState>>(new Map());
  const imageBufferRef = useRef<ImageRecord[]>([]);

  function changeMode(next: CrawlMode) {
    setMode(next);
    setConcurrency(MODE_DEFAULTS[next].concurrency);
  }

  function flush(start: number) {
    setPages(new Map(pagesRef.current));
    const buffered = imageBufferRef.current.splice(0);
    if (buffered.length) setImages((prev) => prev.concat(buffered));
    setElapsed(Date.now() - start);
    setNow(Date.now());
  }

  function handleEvent(event: StreamEvent) {
    const map = pagesRef.current;
    const upsert = (url: string, patch: Partial<PageState>) => {
      const existing = map.get(url) ?? { url, path: pathOf(url), status: "pending" as const };
      map.set(url, { ...existing, ...patch });
    };
    switch (event.type) {
      case "sitemap":
        setTotal(event.total);
        for (const url of event.urls) if (!map.has(url)) map.set(url, { url, path: pathOf(url), status: "pending" });
        break;
      case "page-start":
        upsert(event.url, { status: "running" });
        break;
      case "page-done":
        upsert(event.url, { status: "done", title: event.title, count: event.images.length, via: event.via });
        imageBufferRef.current.push(...event.images);
        break;
      case "page-skipped":
        upsert(event.url, { status: "skipped", message: event.reason });
        break;
      case "page-error":
        upsert(event.url, { status: "error", message: event.message });
        break;
      case "fatal":
        setError(event.message);
        break;
      case "throttled":
        setThrottledUntil(Date.now() + event.waitMs);
        break;
      case "page-deferred":
        upsert(event.url, { status: "deferred", message: event.message });
        break;
      case "retry-round":
        setRetryRound({ round: event.round, totalRounds: event.totalRounds, count: event.count, startsAt: Date.now() + event.waitMs });
        break;
      case "asset-map":
        setAssetMapInfo({ file: event.file, assets: event.assets, error: event.error });
        break;
    }
  }

  async function run() {
    if (tab === "eds" || tab === "package" || tab === "config") return;
    const kind: RunKind = tab;
    let request: { endpoint: string; body: unknown };
    if (kind === "sitemap") {
      if (!sitemapUrl.trim()) return setError("Enter a sitemap URL.");
      request = {
        endpoint: "/api/crawl",
        body: { sitemapUrl: sitemapUrl.trim(), mode, concurrency, maxPages: Number(maxPages) || undefined },
      };
    } else {
      const urls = urlInput
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter(Boolean);
      if (urls.length === 0) return setError("Enter at least one URL.");
      request = { endpoint: "/api/extract", body: { urls } };
    }

    setError(null);
    setRunKind(kind);
    setImages([]);
    setTotal(null);
    pagesRef.current = new Map();
    imageBufferRef.current = [];
    setPages(new Map());
    setRunning(true);
    const start = Date.now();
    setElapsed(0);
    setThrottledUntil(0);
    setRetryRound(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setInterval(() => flush(start), 300);

    try {
      const res = await fetch(request.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      await readNdjson(res, handleEvent);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      clearInterval(timer);
      for (const [url, p] of pagesRef.current) {
        if (p.status === "pending" || p.status === "running" || p.status === "deferred")
          pagesRef.current.set(url, {
            ...p,
            status: "error",
            message: p.status === "deferred" ? `${p.message} (cancelled before retry)` : "Cancelled",
          });
      }
      flush(start);
      setRunning(false);
      abortRef.current = null;
    }
  }

  const pageList = [...pages.values()];
  const finished = pageList.filter((p) => p.status === "done" || p.status === "error" || p.status === "skipped").length;
  const failed = pageList.filter((p) => p.status === "error");
  const deferred = pageList.filter((p) => p.status === "deferred");
  const skipped = pageList.filter((p) => p.status === "skipped");
  const rendered = pageList.filter((p) => p.via === "render").length;
  const imageCount = pageList.reduce((n, p) => n + (p.count ?? 0), 0);
  const progressTotal = total ?? pageList.length;
  const pct = progressTotal ? Math.round((finished / progressTotal) * 100) : 0;
  const rate = elapsed > 0 ? finished / (elapsed / 1000) : 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Image Alt &amp; Caption Extractor</h1>
          <p className="text-sm text-slate-500">
            Crawl a whole site from its sitemap, or specific pages, and export image alt text and captions to CSV.
          </p>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-5 inline-flex flex-wrap rounded-xl bg-slate-100 p-1 text-sm font-medium">
          {(
            [
              ["sitemap", "Entire site (sitemap.xml)"],
              ["pages", "Specific pages"],
              ["eds", "Add EDS column to existing CSV"],
              ["package", "Update AEM package"],
              ["config", "AEM ab-config"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              disabled={running}
              className={`rounded-lg px-4 py-1.5 transition ${tab === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"} disabled:cursor-not-allowed`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={tab === "eds" ? "" : "hidden"}>
          <EdsMapper />
        </div>

        <div className={tab === "package" ? "" : "hidden"}>
          <PackageUpdater />
        </div>

        <div className={tab === "config" ? "" : "hidden"}>
          <AemConfig />
        </div>

        <div className={tab === "eds" || tab === "package" || tab === "config" ? "hidden" : ""}>
          {tab === "sitemap" ? (
            <div className="grid gap-4 lg:grid-cols-[1fr_auto_auto_auto]">
              <div>
                <label htmlFor="sitemap" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Sitemap URL
                </label>
                <input
                  id="sitemap"
                  value={sitemapUrl}
                  onChange={(e) => setSitemapUrl(e.target.value)}
                  disabled={running}
                  placeholder="https://www.example.com/sitemap.xml"
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 outline-none transition focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-100 disabled:opacity-60"
                />
                <p className="mt-1 text-xs text-slate-400">Sitemap indexes and .xml.gz files are followed automatically.</p>
              </div>
              <div>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">Mode</span>
                <div className="inline-flex rounded-xl border border-slate-300 p-0.5 text-sm">
                  {(
                    [
                      ["fast", "Fast (HTML)"],
                      ["render", "Full render (JS)"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => changeMode(key)}
                      disabled={running}
                      className={`rounded-lg px-3 py-1.5 transition ${mode === key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 max-w-56 text-xs text-slate-400">
                  {mode === "fast"
                    ? "Parses server HTML in parallel. Blocked pages fall back to rendering."
                    : "Runs page JavaScript. Use for client-rendered sites."}
                </p>
              </div>
              <div>
                <label htmlFor="concurrency" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Parallel workers: <span className="font-semibold text-indigo-600">{concurrency}</span>
                </label>
                <input
                  id="concurrency"
                  type="range"
                  min={1}
                  max={MODE_DEFAULTS[mode].max}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  disabled={running}
                  className="mt-2 w-40 accent-indigo-600"
                />
              </div>
              <div>
                <label htmlFor="maxPages" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Max pages
                </label>
                <input
                  id="maxPages"
                  type="number"
                  min={1}
                  value={maxPages}
                  onChange={(e) => setMaxPages(e.target.value)}
                  disabled={running}
                  placeholder="All"
                  className="w-28 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-100"
                />
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor="urls" className="mb-1.5 block text-sm font-medium text-slate-700">
                Page URLs <span className="font-normal text-slate-400">(one per line, up to 25)</span>
              </label>
              <textarea
                id="urls"
                rows={3}
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                disabled={running}
                className="w-full resize-y rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 outline-none transition focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-100 disabled:opacity-60"
                placeholder="https://www.example.com/"
              />
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {running ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={run}
                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
              >
                {tab === "sitemap" ? "Crawl site" : "Extract images"}
              </button>
            )}
            <p className="text-xs text-slate-400">Pages are loaded through a headless Chromium, so Cloudflare-protected sites work.</p>
          </div>
          {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          {assetMapInfo && (
            <p
              className={`mt-3 rounded-lg px-3 py-2 text-xs ${assetMapInfo.file ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"}`}
            >
              {assetMapInfo.file
                ? `EDS image path mapping: ${assetMapInfo.file} (${assetMapInfo.assets.toLocaleString()} assets)`
                : assetMapInfo.error
                  ? `Could not load the EDS asset map: ${assetMapInfo.error}`
                  : "No asset map CSV found in the input folder, so the EDS image path column will be empty."}
            </p>
          )}
        </div>
      </section>

      <div className={tab === "eds" || tab === "package" || tab === "config" ? "hidden" : ""}>
        {(running || pageList.length > 0) && runKind === "sitemap" && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <div className="font-medium text-slate-700">
                {total === null ? (
                  running ? (
                    "Reading sitemap…"
                  ) : (
                    "No pages crawled"
                  )
                ) : (
                  <>
                    {finished} / {total} pages
                    <span className="ml-2 font-normal text-slate-400">{pct}%</span>
                  </>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 text-slate-500">
                <span>{imageCount.toLocaleString()} images</span>
                {rendered > 0 && <span>{rendered} rendered</span>}
                {skipped.length > 0 && <span>{skipped.length} skipped</span>}
                {deferred.length > 0 && <span className="text-amber-600">{deferred.length} to retry</span>}
                {failed.length > 0 && <span className="text-rose-600">{failed.length} failed</span>}
                <span>{formatDuration(elapsed)}</span>
                {finished > 0 && <span>{rate.toFixed(1)} pages/s</span>}
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all duration-300 ${running ? "bg-indigo-500" : "bg-emerald-500"}`}
                style={{ width: `${total === null && running ? 3 : pct}%` }}
              />
            </div>
            {running && retryRound && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Retry round {retryRound.round}/{retryRound.totalRounds}:{" "}
                {retryRound.startsAt > now
                  ? `waiting ${Math.ceil((retryRound.startsAt - now) / 1000)}s for the site to cool down, then retrying ${retryRound.count} rate-limited page${retryRound.count === 1 ? "" : "s"} with fewer workers.`
                  : `retrying ${deferred.length} page${deferred.length === 1 ? "" : "s"} with fewer workers…`}
              </p>
            )}
            {running && throttledUntil > now && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                The site is rate-limiting requests. Pausing all workers for {Math.ceil((throttledUntil - now) / 1000)}s, then retrying.
                Lowering parallel workers helps avoid this.
              </p>
            )}
            {failed.length > 0 && (
              <div className="mt-4 max-h-40 overflow-auto rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {failed.map((p) => (
                  <div key={p.url} className="truncate">
                    <span className="font-mono">{p.path}</span> — {p.message}
                  </div>
                ))}
              </div>
            )}
            {pageList.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">Show all pages</summary>
                <div className="mt-2 max-h-72 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-100">
                  {pageList.map((p) => (
                    <PageRow key={p.url} page={p} label={p.path} />
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        {pageList.length > 0 && runKind === "pages" && (
          <section className="mt-6 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {pageList.map((p) => (
              <PageRow key={p.url} page={p} label={p.url} />
            ))}
          </section>
        )}

        <ResultsView images={images} setImages={setImages} pages={pageList} exportKind={runKind} running={running} />
      </div>
    </div>
  );
}

function PageRow({ page, label }: { page: PageState; label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm">
      <StatusDot status={page.status} />
      <span className="truncate font-mono text-xs text-slate-700">{label}</span>
      {page.title && <span className="hidden truncate text-xs text-slate-400 md:inline">— {page.title}</span>}
      <span className="ml-auto shrink-0 text-xs text-slate-500">
        {page.status === "running" && "Loading…"}
        {page.status === "pending" && "Queued"}
        {page.status === "done" && `${page.count} images${page.via === "render" ? " · rendered" : ""}`}
        {page.status === "skipped" && <span className="text-amber-600">{page.message}</span>}
        {page.status === "deferred" && <span className="text-amber-600">Will retry at end: {page.message}</span>}
        {page.status === "error" && <span className="text-rose-600">{page.message}</span>}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: PageState["status"] }) {
  if (status === "running")
    return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />;
  const color = {
    pending: "bg-slate-300",
    done: "bg-emerald-500",
    skipped: "bg-amber-400",
    error: "bg-rose-500",
    deferred: "bg-amber-500 animate-pulse",
  }[status];
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
}
