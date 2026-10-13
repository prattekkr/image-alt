import { unzipSync } from "fflate";
import {
  changeRow,
  DEFAULT_UPDATE_OPTIONS,
  listPackagePages,
  liveUrlFor,
  updatePackage,
  type ChangeRow,
  type CsvImageRow,
  type UpdateOptions,
  type UpdateResult,
} from "./aemPackage";
import type { AssetMap } from "./assetMap";
import { crawlSitemap } from "./crawler";
import { toCsv } from "./csv";
import { pageKeyFromCsvPath } from "./aemPackage";
import type { CrawlMode, ImageRecord } from "./types";

/**
 * One-step package update: reads the pages in the AEM package, crawls the same paths on the live
 * site (path after the language root), maps the images to EDS asset URLs, and updates the package.
 */

export type AutoUpdateEvent =
  | { type: "phase"; phase: "reading" | "crawling" | "updating" | "done"; message: string }
  | { type: "progress"; done: number; total: number; notLive: number; images: number }
  | { type: "notice"; message: string };

export interface AutoUpdateOptions extends UpdateOptions {
  mode?: CrawlMode;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface AutoUpdateResult extends UpdateResult {
  liveCsv: string;
  site: string;
  pagesInPackage: number;
  pagesCrawled: number;
  pagesNotLive: number;
}

/**
 * "abbvie.co.nz" -> "https://abbvie.co.nz"; "https://www.abbvie.ch/fr/" -> "https://www.abbvie.ch/fr".
 * Keeps a language/path prefix; drops a trailing slash and ".html". Throws on invalid input.
 */
export function normalizeSite(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Enter the live site domain, e.g. https://www.abbvie.co.nz");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const basePath = u.pathname.replace(/\.html?$/i, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${basePath}`;
}

export async function autoUpdatePackage(
  packageZip: Uint8Array,
  siteInput: string,
  assets: AssetMap,
  options: AutoUpdateOptions,
  emit: (event: AutoUpdateEvent) => void,
): Promise<AutoUpdateResult> {
  const site = normalizeSite(siteInput);

  emit({ type: "phase", phase: "reading", message: "Reading package pages" });
  const names: string[] = [];
  // List entries without decompressing them.
  unzipSync(packageZip, {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  const { roots, pages } = listPackagePages(names, options.siteRoot);
  if (roots.length === 0) throw new Error("Could not find a language root in the package (no */index/.content.xml page).");

  // One live URL per distinct page path (several language roots can share a path).
  const urlToPage = new Map<string, { path: string; files: string[] }>();
  for (const p of pages) {
    const url = liveUrlFor(site, p.path);
    const entry = urlToPage.get(url) ?? { path: p.path, files: [] };
    entry.files.push(p.file);
    urlToPage.set(url, entry);
  }
  const urls = [...urlToPage.keys()];

  emit({ type: "phase", phase: "crawling", message: `Crawling ${urls.length} pages on ${site}` });
  const records: ImageRecord[] = [];
  const notLive: ChangeRow[] = [];
  let done = 0;
  await crawlSitemap(
    site,
    {
      mode: options.mode ?? "fast",
      concurrency: options.concurrency ?? 16,
      urls,
      maxPages: urls.length,
      assetMap: assets,
      signal: options.signal,
    },
    (event) => {
      if (event.type === "page-done") {
        done++;
        records.push(...event.images);
      } else if (event.type === "page-error" || event.type === "page-skipped") {
        done++;
        const page = urlToPage.get(event.url);
        const message = event.type === "page-error" ? event.message : event.reason;
        for (const file of page?.files ?? []) {
          notLive.push(
            changeRow({
              pagePath: page?.path ?? event.url,
              packageFile: file,
              status: "page-not-live",
              imageUrl: event.url,
              note: message,
            }),
          );
        }
      } else if (event.type === "throttled") {
        emit({ type: "notice", message: `${event.message}. Pausing ${Math.round(event.waitMs / 1000)}s and retrying` });
        return;
      } else if (event.type === "retry-round") {
        emit({ type: "notice", message: `Retrying ${event.count} rate-limited page(s), round ${event.round}/${event.totalRounds}` });
        return;
      } else {
        return;
      }
      emit({ type: "progress", done, total: urls.length, notLive: new Set(notLive.map((n) => n.imageUrl)).size, images: records.length });
    },
  );
  if (options.signal?.aborted) throw new Error("Cancelled");

  emit({ type: "phase", phase: "updating", message: "Updating package" });
  // Live rows grouped by package page path, in page order (records arrive per page, in DOM order).
  // The key comes from the URL we requested, so a live path prefix (e.g. "/fr") doesn't matter.
  const rowsByPage = new Map<string, CsvImageRow[]>();
  for (const r of records) {
    const key = (urlToPage.get(r.pageUrl)?.path ?? pageKeyFromCsvPath(r.pagePath)).toLowerCase();
    const row: CsvImageRow = {
      pagePath: r.pagePath,
      imageUrl: r.imageUrl,
      altText: r.altText.trim(),
      caption: r.caption.trim(),
      edsImagePath: r.edsImagePath,
    };
    rowsByPage.set(key, [...(rowsByPage.get(key) ?? []), row]);
  }
  const result = updatePackage(packageZip, rowsByPage, assets, { ...DEFAULT_UPDATE_OPTIONS, ...options }, notLive);

  emit({ type: "phase", phase: "done", message: "Done" });
  return {
    ...result,
    liveCsv: toCsv(records, "path"),
    site,
    pagesInPackage: urls.length,
    pagesCrawled: urls.length - new Set(notLive.map((n) => n.imageUrl)).size,
    pagesNotLive: new Set(notLive.map((n) => n.imageUrl)).size,
  };
}
