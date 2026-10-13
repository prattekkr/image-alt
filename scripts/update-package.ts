/**
 * Copies live-site alt text and captions into an AEM content package.
 *
 * Automatic (crawls every package page on the live site, then updates the package):
 *   npm run update-package -- --package zip/NZ-EN.zip --site https://www.abbvie.co.nz
 *
 * From an existing live CSV:
 *   npm run update-package -- --package zip/NZ-EN.zip --csv output/<crawl-folder>
 *
 * Options: [--asset-map FILE] [--out DIR] [--no-card-image] [--no-fragments] [--no-caption] [--no-alt]
 *          [--site-root content/.../nz/en] [--concurrency 16]
 *
 * Writes <package>-alt-updated.zip, <package>-alt-update-report.csv and (automatic mode)
 * <package>-live-images.csv. The original package is not changed.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_UPDATE_OPTIONS, readCsvImageRows, updatePackage, type UpdateResult } from "../src/lib/aemPackage";
import { loadAssetMap } from "../src/lib/assetMap";
import { autoUpdatePackage } from "../src/lib/autoUpdate";
import { closeBrowser } from "../src/lib/browser";
import { parseArgs } from "./args";

async function csvFilesIn(target: string): Promise<string[]> {
  if ((await stat(target)).isFile()) return [target];
  const out: string[] = [];
  for (const e of await readdir(target, { withFileTypes: true })) {
    const full = path.join(target, e.name);
    if (e.isDirectory()) out.push(...(await csvFilesIn(full)));
    else if (e.name.toLowerCase().endsWith(".csv")) out.push(full);
  }
  // Prefer the combined CSV so page order follows the crawl.
  return out.sort((a, b) => Number(/all-pages\.csv$/i.test(b)) - Number(/all-pages\.csv$/i.test(a)));
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (!args.package || (!args.csv && !args.site)) {
    console.error(
      "Usage: npm run update-package -- --package <aem-package.zip> (--site <live-domain> | --csv <csv-file-or-folder>) [--asset-map FILE] [--out DIR]",
    );
    process.exit(1);
  }
  const loaded = await loadAssetMap(args["asset-map"]);
  if (!loaded) throw new Error("No asset map found. Put it in ./input or pass --asset-map FILE.");
  console.log(`Asset map: ${loaded.file} (${loaded.map.size.toLocaleString()} assets)`);

  const pkgPath = path.resolve(args.package);
  const packageBytes = new Uint8Array(await readFile(pkgPath));
  const options = {
    ...DEFAULT_UPDATE_OPTIONS,
    updateAlt: args["no-alt"] !== "true",
    updateCaption: args["no-caption"] !== "true",
    includeCardImage: args["no-card-image"] !== "true",
    includeFragments: args["no-fragments"] !== "true",
    siteRoot: args["site-root"],
  };

  let result: UpdateResult;
  let liveCsv: string | undefined;
  if (args.csv) {
    const files = await csvFilesIn(path.resolve(args.csv));
    const rowsByPage = readCsvImageRows(await Promise.all(files.map(async (f) => ({ name: f, text: await readFile(f, "utf8") }))));
    result = updatePackage(packageBytes, rowsByPage, loaded.map, options);
  } else {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const auto = await autoUpdatePackage(
      packageBytes,
      args.site,
      loaded.map,
      { ...options, concurrency: Number(args.concurrency) || undefined, signal: controller.signal },
      (e) => {
        if (e.type === "phase") process.stdout.write(`\n${e.message}`);
        else if (e.type === "progress") process.stdout.write(`\r  ${e.done}/${e.total} pages · ${e.images} images · ${e.notLive} not live   `);
        else if (e.type === "notice") process.stdout.write(`\n  ! ${e.message}\n`);
      },
    );
    process.stdout.write("\n");
    console.log(`Live site ${auto.site}: ${auto.pagesInPackage} package pages crawled, ${auto.pagesCrawled} found, ${auto.pagesNotLive} not live`);
    result = auto;
    liveCsv = auto.liveCsv;
  }

  const outDir = path.resolve(args.out || path.dirname(pkgPath));
  await mkdir(outDir, { recursive: true });
  const base = path.basename(pkgPath).replace(/\.zip$/i, "");
  const zipOut = path.join(outDir, `${base}-alt-updated.zip`);
  const reportOut = path.join(outDir, `${base}-alt-update-report.csv`);
  await writeFile(zipOut, result.zip);
  await writeFile(reportOut, result.reportCsv, "utf8");
  if (liveCsv) await writeFile(path.join(outDir, `${base}-live-images.csv`), liveCsv, "utf8");

  const s = result.summary;
  console.log(`Language root: ${s.siteRoot} (${s.packagePages} package pages; fragments: ${s.fragments.join(", ") || "none"})`);
  console.log(`Live rows: ${s.csvRows} on ${s.csvPages} pages, ${s.pagesMatched} pages found in the package, ${s.headerFooterRows} header/footer rows`);
  console.log(`Images matched: ${s.imagesMatched}, fields updated: ${s.fieldsUpdated}, files modified: ${s.filesModified}`);
  console.log("By status:", s.byStatus);
  console.log(`Wrote ${zipOut}\n      ${reportOut}${liveCsv ? `\n      ${path.join(outDir, `${base}-live-images.csv`)}` : ""}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
