/**
 * Crawl every page in a sitemap and write one CSV per page plus a combined CSV.
 *
 *   npm run crawl -- https://www.abbvie.co.nz/sitemap.xml [--mode fast|render] [--concurrency 16] [--max-pages 100] [--out ./output]
 *                    [--asset-map input/asset-map-dev.csv | --no-asset-map]
 *
 * If an asset map CSV is found (./input/asset-map*.csv by default), an "EDS image path" column is filled in.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAssetMap, type AssetMap } from "../src/lib/assetMap";
import { closeBrowser, pathOf } from "../src/lib/browser";
import { CONCURRENCY_LIMITS, crawlSitemap } from "../src/lib/crawler";
import { buildPerPageCsvFiles } from "../src/lib/csv";
import type { CrawlMode, ImageRecord } from "../src/lib/types";
import { parseArgs } from "./args";

async function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const sitemapUrl = positional[0];
  if (!sitemapUrl) {
    console.error(
      "Usage: npm run crawl -- <sitemap-url> [--mode fast|render] [--concurrency N] [--max-pages N] [--out DIR] [--asset-map FILE | --no-asset-map]",
    );
    process.exit(1);
  }
  const mode: CrawlMode = args.mode === "render" ? "render" : "fast";
  const concurrency = Number(args.concurrency) || CONCURRENCY_LIMITS[mode].default;
  const maxPages = Number(args["max-pages"]) || undefined;
  const host = new URL(sitemapUrl).hostname.replace(/^www\./, "");
  const outDir = path.resolve(args.out || "output", `${host}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);

  let assetMap: AssetMap | undefined;
  if (args["no-asset-map"] !== "true") {
    const loaded = await loadAssetMap(args["asset-map"]);
    if (loaded) {
      assetMap = loaded.map;
      console.log(`EDS mapping: ${loaded.file} (${loaded.map.size.toLocaleString()} assets)`);
    } else {
      console.log("EDS mapping: no asset map found in ./input, the EDS image path column will be empty");
    }
  }

  let sitemapUrls: string[] = [];
  const succeeded = new Set<string>();
  const images: ImageRecord[] = [];
  const problems: string[] = [];
  const toRetry = new Set<string>();
  let finished = 0;
  const started = Date.now();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  const progress = () => {
    const secs = (Date.now() - started) / 1000;
    process.stdout.write(
      `\r  ${finished}/${sitemapUrls.length} pages · ${images.length} images · ${toRetry.size} to retry · ${problems.length} failed/skipped · ${secs.toFixed(1)}s · ${(finished / secs || 0).toFixed(1)} pages/s   `,
    );
  };

  console.log(`Crawling ${sitemapUrl} (mode=${mode}, concurrency=${concurrency})`);
  await crawlSitemap(sitemapUrl, { mode, concurrency, maxPages, signal: controller.signal, assetMap }, (event) => {
    switch (event.type) {
      case "sitemap":
        sitemapUrls = event.urls;
        break;
      case "page-done":
        finished++;
        succeeded.add(event.url);
        images.push(...event.images);
        break;
      case "page-skipped":
        finished++;
        problems.push(`SKIPPED  ${event.url}  ${event.reason}`);
        break;
      case "page-error":
        finished++;
        problems.push(`FAILED   ${event.url}  ${event.message}`);
        break;
      case "throttled":
        process.stdout.write(`\n  ! ${event.message}. Pausing ${Math.round(event.waitMs / 1000)}s and retrying\n`);
        break;
      case "page-deferred":
        toRetry.add(event.url);
        break;
      case "retry-round":
        process.stdout.write(
          `\n  ↻ Retry round ${event.round}/${event.totalRounds}: ${event.count} rate-limited/transient page(s), starting in ${Math.round(event.waitMs / 1000)}s\n`,
        );
        break;
    }
    if (event.type === "page-done" || event.type === "page-error" || event.type === "page-skipped") toRetry.delete(event.url);
    progress();
  });
  process.stdout.write("\n");

  // Sitemap order, not completion order.
  const pages = sitemapUrls.filter((u) => succeeded.has(u)).map((url) => ({ url, path: pathOf(url) }));
  const files = buildPerPageCsvFiles(pages, images);
  await mkdir(path.join(outDir, "pages"), { recursive: true });
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(outDir, name), content, "utf8")));
  if (problems.length) await writeFile(path.join(outDir, "errors.txt"), problems.join("\n") + "\n", "utf8");

  console.log(`Wrote ${pages.length} page CSVs + all-pages.csv to ${outDir}`);
  if (assetMap) {
    const unique = new Map(images.map((i) => [i.imageUrl, i.edsImagePath]));
    const mapped = [...unique.values()].filter(Boolean).length;
    console.log(`EDS image path found for ${mapped}/${unique.size} unique images (${images.filter((i) => i.edsImagePath).length}/${images.length} rows)`);
  }
  if (problems.length) console.log(`${problems.length} pages failed or were skipped (see errors.txt)`);
}

main()
  .catch((err) => {
    console.error("\n" + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
