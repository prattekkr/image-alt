export type AltStatus = "present" | "empty" | "missing";

export type CrawlMode = "fast" | "render";

export const CONCURRENCY_LIMITS: Record<CrawlMode, { default: number; max: number }> = {
  fast: { default: 16, max: 48 },
  render: { default: 4, max: 12 },
};

export const MAX_PAGES_LIMIT = 10_000;

export interface ImageRecord {
  id: string;
  pageUrl: string;
  pagePath: string;
  imageUrl: string;
  altText: string;
  altStatus: AltStatus;
  caption: string;
  captionSource: string;
  width: number;
  height: number;
  /** DAM asset path exposed by the page (AEM data-asset); used to disambiguate EDS mapping. */
  damPath: string;
  /** openApiUrl from the asset map, or "" when no mapping was found. */
  edsImagePath: string;
  /** How the EDS mapping was found, e.g. "scene7", "dam-path", "uuid"; "" when unmapped. */
  edsMatch: string;
}

export type StreamEvent =
  | { type: "asset-map"; file: string | null; assets: number; error?: string }
  | { type: "sitemap"; sitemapUrl: string; total: number; urls: string[] }
  | { type: "page-start"; url: string }
  | { type: "page-done"; url: string; title: string; images: ImageRecord[]; via?: "fetch" | "render"; ms?: number }
  | { type: "page-skipped"; url: string; reason: string }
  | { type: "page-error"; url: string; message: string }
  | { type: "throttled"; url: string; waitMs: number; message: string }
  | { type: "page-deferred"; url: string; message: string }
  | { type: "retry-round"; round: number; totalRounds: number; count: number; waitMs: number }
  | { type: "fatal"; message: string }
  | { type: "done"; elapsedMs?: number };

export interface AssetMapFile {
  name: string;
  sizeBytes: number;
  modified: string;
}

export interface MapEdsFileResult {
  /** File name, including folders when it came from a ZIP (e.g. "pages/home.csv"). */
  name: string;
  /** Updated CSV (or passthrough text) content; absent when skipped. */
  content?: string;
  rows: number;
  mapped: number;
  skipped?: string;
  passthrough?: boolean;
}

export interface MapEdsResponse {
  assetMap: { name: string; assets: number };
  files: MapEdsFileResult[];
  totals: { files: number; rows: number; mapped: number; byMethod: Record<string, number> };
  /** Unique image URLs without a match (capped). */
  unmatched: string[];
  unmatchedTotal: number;
}

export interface PackageChangeRow {
  pagePath: string;
  packageFile: string;
  node: string;
  status: string;
  altField: string;
  oldAlt: string;
  newAlt: string;
  altStatus: string;
  captionField: string;
  oldCaption: string;
  newCaption: string;
  captionStatus: string;
  imageUrl: string;
  edsImagePath: string;
  note: string;
}

export interface UpdatePackageResponse {
  assetMap: string;
  summary: {
    siteRoot: string;
    packagePages: number;
    csvRows: number;
    csvPages: number;
    pagesMatched: number;
    filesModified: number;
    imagesMatched: number;
    fieldsUpdated: number;
    headerFooterRows: number;
    byStatus: Record<string, number>;
    fragments: string[];
  };
  changes: PackageChangeRow[];
  changesTotal: number;
  packageName: string;
  packageBase64: string;
  reportName: string;
  reportCsv: string;
}

export type AutoUpdateStreamEvent =
  | { type: "phase"; phase: "reading" | "crawling" | "updating" | "done"; message: string }
  | { type: "progress"; done: number; total: number; notLive: number; images: number }
  | { type: "notice"; message: string }
  | { type: "fatal"; message: string }
  | ({
      type: "result";
      site: string;
      pagesInPackage: number;
      pagesCrawled: number;
      pagesNotLive: number;
      liveCsvName: string;
      liveCsv: string;
    } & UpdatePackageResponse);
