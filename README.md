# Image Alt & Caption Extractor

A Next.js app (plus a CLI) that crawls a whole site from its `sitemap.xml`, or specific pages, finds every image, and exports each image's **alt text** and **caption** to CSV. You get one CSV per page plus a combined CSV.

## Getting started

```bash
npm install
npx playwright install chromium   # one-time browser download
npm run dev                       # http://localhost:3000
```

Production: `npm run build` then `npm start`.

## Add an AEM Author ab-config entry

Choose **AEM ab-config**, select an **Environment**, enter the Author origin, Basic Auth credentials and content root, then click **Find ab-config pages**. No configuration Value is needed for discovery.
The app queries the selected Author first, then automatically reads app-root `aem-ab-config-dev.json` to populate values for only the returned pages. No config file picker is needed. Review/edit the values, fill unmatched rows, then click **Apply all N values**. This writes directly to Author; it does not update a ZIP or publish pages.

- Query Builder finds `cq:Page` nodes named `ab-config` under the root, in batches of 100.
- After querying Author, discovery automatically reads `aem-ab-config-dev.json`. Exact page-path matches use its saved mappings, converted from the saved environment to the selected environment. Saved pages not returned by the current Author query are excluded, not submitted. The selected root and environment are never replaced by values in the saved file.
- If there is no saved mapping for a returned page (or no saved file), discovery reads `sites.json` (`{ "sites": [{ "domain": "...", "contentPath": "..." }] }`). A page matches exactly `<contentPath>/ab-config`; trailing slashes on contentPath are ignored. Only domain and contentPath are used, not site status or language. The UI explicitly reports which source was used.
- Environment controls the Value derived from domain. For `abbvie.com`: **Dev** = `https://www-d1.abbvie.com`, **Test** = `https://www-t1.abbvie.com`, **QA** = `https://www-q1.abbvie.com`, **Prod** = `abbvie.com` exactly as written in sites.json. Prod is the default, preserving the original behavior. Non-production values use HTTPS and replace an existing `www.` prefix rather than duplicating it; any explicit language path is retained. The Author URL is entered separately, not inferred from the live domain.
- Values remain editable. Unmatched pages and conflicting duplicate mappings are flagged and left blank for manual input; no other country's domain is guessed.
- Malformed, unreadable or invalid saved config files produce an explicit discovery error rather than silently ignoring saved overrides. Keep the saved config and `sites.json` alongside `package.json` when deploying; edits are loaded on the next discovery without rebuilding.
- Each page receives a new `jcr:content/row_<unique-id>` child with `jcr:primaryType=nt:unstructured`, String `Key=liveDomainToCacheIndex` and String `Value=<your input>`.
- Each page receives its own input Value, including any language path you entered. All values must be nonempty before applying or saving. Changing environment, Author URL, username or root clears the preview and requires **Find ab-config pages** on the new target. Re-entering the password preserves the preview. Apply writes the reviewed values as entered, without re-deriving them, and revalidates all page paths against the target Author query first.
- Existing children with this Key are skipped without changing their values. No unrelated properties or nodes are changed.
- Four workers create nodes in parallel. Every write is read back and verified; the table distinguishes created, existing and failed pages. Authentication, permission and transport failures are reported.
- Credentials remain only in the current form/request; they are not persisted or logged, and the password field is cleared after applying. HTTPS is required except for localhost AEM.
- Use an account with Query Builder read access and permission to create children beneath the selected pages. Requests use server-side Basic Auth, not browser session cookies. If Author returns 403, check permissions and your environment's Sling POST/CSRF policy.
- Do not run concurrent updates for the same root: the existing-key check is not an atomic repository lock. A failed verification may still mean the node was created; inspect Author before retrying. Retrying skips an existing key.
- Changes are not transactional across pages; successful writes remain if other pages fail. Keep a content backup and use this tool only on a trusted, access-controlled app instance.

Run the focused mocked-Author tests with `npm run test:aem-config`. These validate the request properties and failure behavior, but do not replace checking against your own AEM Author.

### Save and reuse mappings across environments

1. Discover pages and review/edit values, then choose **Save config**. This atomically saves the reference file `aem-ab-config-dev.json` on the app server and downloads a backup named for the selected environment.
2. Select the target Environment, enter its Author URL, credentials and root, then click **Find ab-config pages**.
3. The app queries that Author and automatically fills only its returned pages from the reference file. Dev `https://www-d1.abbvie.com` becomes Test `https://www-t1.abbvie.com` without re-entering mappings or selecting a file.
4. Review the values and choose **Apply all**. The API revalidates page existence/scope against the target Author before writing. Existing keys remain skipped.

The versioned JSON stores only the root, selected environment and page mappings (base domain plus reviewed value). It does **not** save the Author URL, username or password. Unedited mappings preserve the original sites.json domain exactly when switching to Prod. For an edited non-production URL, its `www-d1`/`www-t1`/`www-q1` prefix is removed to obtain the new base domain; explicit path/query/fragment values are retained. Values manually entered without an environment prefix become the new base as entered.

The reference filename remains `aem-ab-config-dev.json` even when saved from another environment; its internal environment field determines how URLs are converted. Saving replaces the reference with the currently reviewed mappings, so retain the downloaded backup when saving a narrower subset. The app needs write permission to its directory for Save config; write failures are reported explicitly. If deployed on another app server, copy the reference file beside package.json once; the UI then uses it automatically.

Saving/discovery do not mutate Author. Unsupported versions, malformed mappings, duplicate pages and out-of-root paths are rejected explicitly. Saved mappings cannot introduce nonexistent target pages: only fresh query results appear in the preview. A genuine page deletion or permissions change after preview still requires a fresh query before applying.

## Crawl a whole site

### In the UI

1. Choose **Entire site (sitemap.xml)** and enter a sitemap URL, e.g. `https://www.abbvie.co.nz/sitemap.xml`.
2. Pick a mode and the number of parallel workers, then click **Crawl site**.
3. Download **ZIP · CSV per page**, or **Combined CSV**. Filters (alt status, duplicates, icons, header/footer images, search) apply to both exports. You can also edit alt text and captions inline before exporting.

### From the command line

```bash
npm run crawl -- https://www.abbvie.co.nz/sitemap.xml
npm run crawl -- <sitemap-url> --mode render --concurrency 4 --max-pages 200 --out ./output
```

Output goes to `output/<host>-<timestamp>/`:

```
pages/home.csv
pages/who-we-are.csv
pages/who-we-are__our-principles.csv
...
all-pages.csv
errors.txt            # only if some pages failed or were skipped
```

CSV columns: **Page Path, Image URL, Alt Text, Caption, EDS image path**. Alt text, caption and EDS image path are left empty when there is no value.

## EDS image path mapping

Put the AEM asset map CSV in `input/`, e.g. `input/asset-map-dev.csv`, with the columns `path, uuid, scene7Name, scene7File, damStatus, openApiUrl, isCF`. Every crawl (UI and CLI) then fills the **EDS image path** column with the matching asset's `openApiUrl`.

Lookup order for each image:

1. **Scene7 URLs**, e.g. `https://abbvie.scene7.com/is/image/abbviecorp/pipette-closeup-1?ts=...`:
   - The `abbviecorp/pipette-closeup-1` part is matched exactly against `scene7File`. The query string and smart-crop suffixes such as `:Square` are ignored.
   - If several assets share that Scene7 name, the page's own DAM path (AEM `data-asset`) picks the right one. Otherwise an approved asset is preferred.
2. **DAM paths:** `/content/dam/abbvie-com2/icons/footer-instagram.svg` from the image URL, or from the page's `data-asset`, is matched against `path`.
   - The extra `corporate/` segment in the asset map is ignored.
   - URL encoding (`%20`) is decoded.
   - The match is case-sensitive first, with a case-insensitive fallback only when it is unambiguous.
3. **AEM delivery URLs** containing `urn:aaid:aem:<uuid>` are matched against `uuid`.

If no asset matches, the column is left empty. There is no fuzzy matching. The UI shows how each match was found and has an "EDS path found / not found" filter.

The asset map file is chosen in this order:
1. `--asset-map FILE` (CLI)
2. The `ASSET_MAP_PATH` environment variable
3. The newest `input/asset-map*.csv`
4. Any other `input/*.csv`

To crawl without mapping, use `npm run crawl -- <sitemap> --no-asset-map`.

**Add the column to CSVs you already have.** No re-crawl is needed.

- **In the UI:** open the **"Add EDS column to existing CSV"** tab and drop in your exported CSV files or the ZIP (one CSV per page). Choose an asset map from `input/`, or upload a different one, then click **Add EDS image path column**.
  - All existing columns are kept.
  - A single CSV comes back as a CSV with the same name. Several files, or a ZIP, come back as a ZIP with the same folder structure.
  - You also get stats and a list of the images that weren't found.
- **From the command line:** the files are updated in place, or written to `--out`:

```bash
npm run map-eds -- output/abbvie.co.nz-2026-10-12T09-42-41
npm run map-eds -- some/file.csv --asset-map input/asset-map-dev.csv --out output/mapped
```

`map-eds` only has the image URL to work with. A fresh crawl also uses each page's DAM path, so re-crawling gives slightly better results: on abbvie.co.nz, 186 of 190 images matched with a crawl versus 185 with `map-eds`, and ambiguous Scene7 names are resolved correctly.

Sitemap indexes (nested sitemaps) and `.xml.gz` sitemaps are followed automatically.

## Update an AEM package with live alt text and captions

Copies the live site's image alt text and captions (from the crawl CSV) into an AEM content package (FileVault ZIP, `jcr_root/...`). The original package is not changed. A new `<name>-alt-updated.zip` is written, plus a report CSV.

- **UI:** the **Update AEM package** tab.
  - **Crawl live site automatically** (default): upload the package, enter the live domain (e.g. `https://www.abbvie.co.nz`), and click **Update package**.
    - Every page in the package is crawled at `<domain>/<path after the language folder>.html` (`index` → `/`). Several language roots, such as `nz/en` and `language-masters/en`, are supported.
    - The domain can include a path prefix, e.g. `https://www.abbvie.ch/fr`. Pages are then crawled at `https://www.abbvie.ch/fr/<path>.html`, and the home page at `https://www.abbvie.ch/fr.html`.
    - The images are mapped to EDS paths and the package is updated, in one step.
    - Pages that aren't on the live site (e.g. 404) are only reported, as `page-not-live`.
    - Three downloads: the updated package, the report, and the live CSV.
  - **Use an existing live CSV:** upload the package and a crawl CSV instead of crawling.
- **CLI:**
  ```bash
  npm run update-package -- --package zip/NZ-EN.zip --site https://www.abbvie.co.nz     # automatic
  npm run update-package -- --package zip/NZ-EN.zip --csv output/<crawl-folder>          # from a CSV
  # options: --asset-map FILE  --out DIR  --no-alt  --no-caption  --no-fragments  --site-root content/.../nz/en  --concurrency N
  ```

Rules:

- **Pages:**
  - The site root is normally the folder that contains `index/.content.xml`, e.g. `content/abbvie-nextgen-eds/corporate/abbvie-com/nz/en`. Partial packages without an index page are also supported when their paths identify a country/language root (such as `nl/nl`) or a language-master root (such as `language-masters/nl`). A news-only package keeps `/news/...` as its live page paths; a homepage does not need to be added.
  - For other layouts, specify the exact language root using the CLI's `--site-root` option. The updater does not guess a root from the common ancestor of arbitrary pages.
  - `/` maps to `<root>/index/.content.xml`, and `/who-we-are/our-principles.html` maps to `<root>/who-we-are/our-principles/.content.xml`. Matching ignores letter case.
  - Package pages without a matching live page are not modified.
- **Images:**
  - Matched within the same page by asset: the `urn:aaid:aem` UUID from the CSV's EDS image path, with DAM paths resolved through the asset map. Delivery host and rendition differences don't matter.
  - If an image appears more than once on a page, CSV rows and XML nodes are paired in order.
- **Values:** the live alt text and caption overwrite the package values, including empty values.
  - Alt fields: `image`→`imageAlt`, `background`→`backgroundAlt`/`backgroundImageAlt`, `imageIcon`→`imageIconAlt`, and video posters (`placeholderImage` on `video`, `posterImage` on `brightcove-video`)→`posterAccessibilityLabel`.
  - Captions: `caption` on image components that have it, and `videoCaption` on video components that have it.
- **Header/footer:**
  - Images with the same alt text on at least half of the live pages are treated as header/footer.
  - They aren't paired with page content. Instead they update the `nav`/`header`/`footer` fragments, using header rows for nav/header and footer rows for footer.
- **Page teaser excluded:** `cardImage` and `cardImageAlt` are never updated or added, even if the teaser asset matches a live image. This applies to CSV and automatic mode, the API and CLI. There is no teaser-update checkbox; legacy `includeCardImage` inputs cannot enable it. Ordinary content images using the same asset still receive their own alt/caption updates.
- **Nothing else changes:**
  - Only alt/caption attribute values are edited, or added when missing.
  - Every other file in the ZIP keeps its original bytes and order.
  - Values are escaped for docview XML: `&`, `<`, `"`, and a leading `{` or `[`.

Report columns (one row per image): **Page Path, Status, Alt Old, Alt New, Alt Status, Caption Old, Caption New, Caption Status, Alt Property, Caption Property, Node, Package File, Image URL, EDS image path, Note**. Alt/Caption Status is `updated`, `unchanged`, `no-field` (the component has no such property), or empty (not applicable).

Report statuses:
- `updated`: the value was changed.
- `unchanged`: the package already had the live value.
- `not-found-on-page`: the image is on the live page but not on that package page.
- `no-asset-match`: the live image isn't in the asset map.
- `no-alt-field`: the component has no alt property.
- `page-not-in-package`: the live page doesn't exist in the package.

## Modes

| Mode | How it works | Speed |
| ---- | ------------ | ----- |
| **Fast (HTML)**, default | Fetches each page's server HTML and parses it, many pages in parallel. Pages blocked by a bot challenge fall back to a full render automatically. | abbvie.co.nz: 82 pages in about 1–2s |
| **Full render (JS)** | Opens each page in a headless Chromium tab, runs its JavaScript and scrolls to trigger lazy loading. Images, fonts, CSS and trackers are blocked to keep it light. | About 1–3s per page per tab |

Use **Full render** only for sites that build their images with client-side JavaScript. On abbvie.co.nz, fast mode finds every image that full render finds.

## Cloudflare and bot protection

AbbVie sites sit behind Cloudflare. Plain HTTP clients (curl, Node `fetch`) get `403` even with a browser User-Agent, because Cloudflare also fingerprints the TLS/HTTP client. Every request here goes through a real headless Chromium with a desktop Chrome User-Agent. In fast mode, `fetch()` runs *inside* a browser tab on the target origin, so it uses Chromium's network stack and Cloudflare cookies.

### Rate limiting and retries

1. **During the crawl:** if the site rate-limits (HTTP 429, or a "Just a moment..." challenge), all workers pause together with exponential back-off (5s, 10s, 20s, up to 30s). The page is retried up to 4 times.
2. **Deferred, not failed:** pages that still fail for a temporary reason are set aside as "to retry" instead of failing. Temporary reasons are rate limits, unsolved challenges, HTTP 5xx/408, timeouts and dropped connections.
3. **End-of-crawl retry rounds:** after the main pass, deferred pages get up to **2 retry rounds**. Each round waits for the site to cool down (20s, then 40s) and then retries only those pages, with a quarter of the workers.
4. **Final failures:** only pages that still fail after the last round are reported as failed, with "gave up after 2 retry rounds". Permanent errors such as 404 are reported straight away and not retried.

If rate limiting happens often, lower the number of parallel workers. Full render mode makes far more requests per page and is much more likely to be rate-limited. The cooldown base can be changed with the `CRAWL_RETRY_COOLDOWN_MS` environment variable (default `20000`).

## What is extracted

**Images:** every `<img>`, including:
- lazy-loaded sources (`data-src`, `srcset`, AEM `data-cmp-src`);
- images that only exist inside `<noscript>`, which is how AEM Core Image components ship them.

Duplicates of the same image outside `<noscript>`, and 1×1 tracking pixels, are ignored.

**Alt status:** each image is marked as having alt text, an empty alt (decorative), or no alt attribute at all.

**Captions:** only AEM's `itemprop="caption"` on the image's component, in a wrapper that belongs only to that image, is used:
- `<meta itemprop="caption" content="…">` (caption hidden): its `content` value.
- `<span class="cmp-image__title" itemprop="caption">…</span>` (caption displayed): its text.

If neither is present, the caption is empty. The image's `title`, AEM's `data-title`, `<figcaption>` and other markup are **not** used.

In the package update, a caption that differs only by whitespace (e.g. a double space) counts as unchanged, so the package text is kept.

## Project structure

- `src/lib/extractor.ts`: image, alt and caption extraction. It runs inside the browser on live or fetched documents.
- `src/lib/browser.ts`: Playwright browser and context, resource blocking, challenge detection, page rendering.
- `src/lib/crawler.ts`: sitemap parsing, in-browser fetchers per origin, worker pool, retries and back-off.
- `src/lib/csv.ts`: CSV generation (UTF-8 BOM, safe against formula injection), per-page file names, ZIP.
- `src/lib/assetMap.ts`: loads the asset-map CSV and maps image URLs to the EDS `openApiUrl`.
- `src/lib/csvParse.ts`: RFC 4180 CSV parser.
- `src/app/api/crawl/route.ts`: `POST { sitemapUrl, mode, concurrency, maxPages }`. Streams NDJSON progress.
- `src/app/api/extract/route.ts`: `POST { urls }` for specific pages.
- `src/app/api/map-eds/route.ts`: `POST` multipart (`files`, optional `assetMapName` / `assetMapFile`). Adds the EDS column to uploaded CSVs or ZIPs.
- `src/app/api/asset-maps/route.ts`: `GET` lists the asset maps in `input/`.
- `src/lib/edsCsv.ts`: adds or refreshes the EDS image path column in a CSV (shared by the UI and the CLI).
- `src/components/`: UI.
- `scripts/crawl.ts`: CLI crawler.
- `scripts/map-eds.ts`: adds the EDS image path column to existing CSVs.
- `scripts/update-package.ts`: CLI to update an AEM package with live alt text and captions.
- `src/lib/aemPackage.ts`: AEM package update (page/image matching, docview editing, report).
- `src/app/api/update-package/route.ts`: `POST` multipart (`package`, `files`, options). Returns the updated package and the report.
