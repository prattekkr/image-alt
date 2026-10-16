import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AssetMap } from "./assetMap";
import { rowsToCsv } from "./csv";
import { parseCsv } from "./csvParse";

/**
 * Copies live-site image alt text and captions (from the crawl CSV) into an AEM content package.
 *
 * - Pages: "/who-we-are.html" -> <siteRoot>/who-we-are/.content.xml, "/" -> <siteRoot>/index/.content.xml.
 *   Package pages without a matching live page are not modified.
 * - Images: matched per page by asset (UUID / DAM path), pairing repeats in document order.
 * - Values: live values overwrite package values, including empty ones.
 * - Header/footer: images in the nav/header/footer fragments get the live header/footer values.
 * - Page teaser properties (cardImage and cardImageAlt) are never changed.
 * - Only alt/caption attribute values change; every other byte of the package stays the same.
 */

export interface UpdateOptions {
  updateAlt: boolean;
  updateCaption: boolean;
  /** Update images in the nav/header/footer fragments from the live header/footer. */
  includeFragments: boolean;
  /** Override the auto-detected site root, e.g. "content/abbvie-nextgen-eds/corporate/abbvie-com/nz/en". */
  siteRoot?: string;
}

export const DEFAULT_UPDATE_OPTIONS: UpdateOptions = {
  updateAlt: true,
  updateCaption: true,
  includeFragments: true,
};

export interface CsvImageRow {
  pagePath: string;
  imageUrl: string;
  altText: string;
  caption: string;
  edsImagePath: string;
}

export type ChangeStatus =
  "updated" | "unchanged" | "no-alt-field" | "not-found-on-page" | "page-not-in-package" | "page-not-live" | "no-asset-match";

/** Per-field outcome: written, already equal, component has no such property, or not applicable/disabled. */
export type FieldStatus = "updated" | "unchanged" | "no-field" | "";

/** One report row per image (or per unmatched live image / page), with alt and caption side by side. */
export interface ChangeRow {
  pagePath: string;
  packageFile: string;
  node: string;
  status: ChangeStatus;
  altField: string;
  oldAlt: string;
  newAlt: string;
  altStatus: FieldStatus;
  captionField: string;
  oldCaption: string;
  newCaption: string;
  captionStatus: FieldStatus;
  imageUrl: string;
  edsImagePath: string;
  note: string;
}

/** A report row with every field empty except the given ones. */
export function changeRow(partial: Partial<ChangeRow> & Pick<ChangeRow, "pagePath" | "status">): ChangeRow {
  return {
    packageFile: "",
    node: "",
    altField: "",
    oldAlt: "",
    newAlt: "",
    altStatus: "",
    captionField: "",
    oldCaption: "",
    newCaption: "",
    captionStatus: "",
    imageUrl: "",
    edsImagePath: "",
    note: "",
    ...partial,
  };
}

export interface UpdateSummary {
  siteRoot: string;
  packagePages: number;
  csvRows: number;
  csvPages: number;
  pagesMatched: number;
  filesModified: number;
  imagesMatched: number;
  fieldsUpdated: number;
  /** CSV rows recognised as header/footer (handled via fragments, not page content). */
  headerFooterRows: number;
  byStatus: Record<string, number>;
  fragments: string[];
}

export interface UpdateResult {
  summary: UpdateSummary;
  changes: ChangeRow[];
  zip: Uint8Array;
  reportCsv: string;
}

/** Image fields in EDS blocks and the alt field(s) that belong to each. */
const IMAGE_FIELDS: Record<string, string[]> = {
  image: ["imageAlt"],
  background: ["backgroundAlt", "backgroundImageAlt"],
  imageIcon: ["imageIconAlt"],
  // Video posters (video / brightcove-video): the accessibility label is the poster's alt text.
  placeholderImage: ["posterAccessibilityLabel"],
  posterImage: ["posterAccessibilityLabel"],
};
/** Caption property per image field, written only when the component has it. */
const CAPTION_FIELDS: Record<string, string> = {
  image: "caption",
  posterImage: "videoCaption",
  placeholderImage: "videoCaption",
};
const FRAGMENT_NAMES = new Set(["nav", "header", "footer"]);

// ---------- FileVault docview value escaping ----------

function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Reads a docview attribute value as plain text (drops a "{Type}" hint and backslash escapes). */
export function readDocviewValue(raw: string): string {
  const v = xmlUnescape(raw).replace(/^\{[A-Za-z]+\}/, "");
  return v.replace(/\\(.)/g, "$1");
}

/** Encodes plain text as a docview String attribute value. */
export function writeDocviewValue(text: string): string {
  let v = text.replace(/\\/g, "\\\\");
  // A leading "{" would be read as a type hint and "[" as a multi-value array.
  if (/^[{[]/.test(v)) v = `\\${v}`;
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xa;")
    .replace(/\r/g, "&#xd;");
}

// ---------- package scanning ----------

interface Attr {
  raw: string;
  valueStart: number;
  valueEnd: number;
}

interface ImageSlot {
  node: string;
  field: string;
  assetKey: string;
  attrs: Map<string, Attr>;
  /** Offset right after the last attribute, where a missing alt attribute can be added. */
  insertAt: number;
  /** Whitespace used before attributes in this tag (keeps docview formatting). */
  indent: string;
  modelFields: string;
  used: boolean;
}

/** The shallowest detected language folder, e.g. "content/.../nz/en". */
export function detectSiteRoot(entryNames: string[]): string | null {
  return detectLanguageRoots(entryNames)[0] ?? null;
}

/**
 * Prefer folders containing index/.content.xml. For partial packages, also recognise
 * country/language and language-masters/language paths outside those roots.
 */
export function detectLanguageRoots(entryNames: string[]): string[] {
  const indexed = entryNames
    .filter((n) => /^jcr_root\/.+\/index\/\.content\.xml$/.test(n))
    .map((n) => n.replace(/^jcr_root\//, "").replace(/\/index\/\.content\.xml$/, ""));
  const inferred: string[] = [];
  for (const name of entryNames) {
    if (!name.endsWith("/.content.xml") || name.startsWith("jcr_root/content/dam/") || indexed.some((root) => name.startsWith(`jcr_root/${root}/`))) continue;
    const match = /^jcr_root\/(content\/.+?\/(?:language-masters|[a-z]{2})\/[a-z]{2}(?:[-_][a-z]{2})?)\//i.exec(name);
    if (match) inferred.push(match[1]);
  }
  const candidates = [...new Set([...indexed, ...inferred])]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const roots: string[] = [];
  for (const c of candidates) if (!roots.some((r) => c.startsWith(r + "/"))) roots.push(c);
  return roots;
}

export interface PackagePage {
  /** Zip entry, e.g. "jcr_root/content/.../nz/en/who-we-are/.content.xml". */
  file: string;
  /** Language root it belongs to, e.g. "content/.../nz/en". */
  root: string;
  /** Path after the language root, e.g. "/who-we-are" or "/index". */
  path: string;
}

/** Every page (.content.xml) under a language root, with its path after the language. */
export function listPackagePages(entryNames: string[], siteRoot?: string): { roots: string[]; pages: PackagePage[] } {
  const override = siteRoot?.replace(/^\/+|\/+$/g, "").replace(/^jcr_root\//, "");
  const roots = override ? [override] : detectLanguageRoots(entryNames);
  const byDepth = [...roots].sort((a, b) => b.length - a.length);
  const pages: PackagePage[] = [];
  for (const n of entryNames) {
    if (!n.endsWith("/.content.xml")) continue;
    const root = byDepth.find((r) => n.startsWith(`jcr_root/${r}/`));
    if (!root) continue;
    const path = n.slice(`jcr_root/${root}`.length).replace(/\/\.content\.xml$/, "");
    if (path) pages.push({ file: n, root, path });
  }
  return { roots, pages };
}

/**
 * Live URL for a package page.
 * Site without a path prefix: "/index" -> "<site>/", "/a/b" -> "<site>/a/b.html".
 * Site with a prefix (e.g. "https://www.abbvie.ch/fr"): "/index" -> "<site>.html", "/a/b" -> "<site>/a/b.html".
 */
export function liveUrlFor(site: string, pagePath: string): string {
  const base = site.replace(/\/+$/, "");
  const hasPrefix = new URL(base).pathname.replace(/\/+$/, "") !== "";
  if (pagePath.toLowerCase() === "/index") return hasPrefix ? `${base}.html` : `${base}/`;
  return `${base}${pagePath}.html`;
}

/** "/who-we-are/Our-Principles.html" -> "/who-we-are/our-principles"; "/" -> "/index". */
export function pageKeyFromCsvPath(pagePath: string): string {
  let p = pagePath.split(/[?#]/)[0].trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as-is
  }
  p = p.replace(/\.html?$/i, "").replace(/\/+$/, "");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p === "/" || p === "") p = "/index";
  return p.toLowerCase();
}

function scanImageSlots(xml: string, assets: AssetMap): ImageSlot[] {
  const slots: ImageSlot[] = [];
  const stack: string[] = [];
  const tagRe = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)(\s*)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, attrText, , selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const node = [...stack.slice(1), name].join("/");
    if (!selfClosing) stack.push(name);

    const attrsOffset = m.index + 1 + name.length;
    const attrs = new Map<string, Attr>();
    const attrRe = /(\s+)([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    let indent = " ";
    while ((a = attrRe.exec(attrText))) {
      if (attrs.size === 0) indent = a[1];
      const valueStart = attrsOffset + a.index + a[0].length - a[3].length - 1;
      attrs.set(a[2], { raw: a[3], valueStart, valueEnd: valueStart + a[3].length });
    }
    const modelFields = attrs.get("modelFields")?.raw ?? "";

    for (const field of Object.keys(IMAGE_FIELDS)) {
      const attr = attrs.get(field);
      if (!attr) continue;
      // Page metadata, including teaser properties, is outside the updater's scope.
      if (node === "jcr:content") continue;
      const ref = readDocviewValue(attr.raw);
      if (!/urn:aaid:aem:|\/content\/dam\//i.test(ref)) continue;
      const assetKey = assets.assetKey(ref);
      if (!assetKey) continue;
      slots.push({ node, field, assetKey, attrs, insertAt: attrsOffset + attrText.length, indent, modelFields, used: false });
    }
  }
  return slots;
}

/** The alt attribute for a slot: an existing one, or one declared in the component's modelFields. */
function altFieldFor(slot: ImageSlot): string | null {
  const candidates = IMAGE_FIELDS[slot.field] ?? [];
  const declared = candidates.find((c) => slot.attrs.has(c)) ?? candidates.find((c) => new RegExp(`[\\[,]${c}@`).test(slot.modelFields));
  if (declared) return declared;
  // Core EDS image component (no modelFields on the node): its alt property is imageAlt.
  if (slot.field === "image" && /\/image\/v\d+\/image$/.test(readDocviewValue(slot.attrs.get("sling:resourceType")?.raw ?? "")))
    return "imageAlt";
  return null;
}

/** The caption property for a slot, if the component has one (existing attribute or declared in modelFields). */
function captionFieldFor(slot: ImageSlot): string | null {
  const field = CAPTION_FIELDS[slot.field];
  if (!field) return null;
  return slot.attrs.has(field) || new RegExp(`[\\[,]${field}@`).test(slot.modelFields) ? field : null;
}

// ---------- CSV input ----------

/**
 * Reads crawl CSVs into rows grouped by page key. When the same page appears in several files
 * (e.g. pages/*.csv and all-pages.csv), only the first file's rows for it are used.
 */
export function readCsvImageRows(csvFiles: { name: string; text: string }[]): Map<string, CsvImageRow[]> {
  const byPage = new Map<string, CsvImageRow[]>();
  for (const { text } of csvFiles) {
    const [header, ...rows] = parseCsv(text);
    if (!header) continue;
    const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
    const pathCol = col("page path");
    const urlCol = col("page url");
    const imageCol = col("image url");
    if (imageCol < 0 || (pathCol < 0 && urlCol < 0)) continue;
    const altCol = col("alt text");
    const capCol = col("caption");
    const edsCol = col("eds image path");

    const fileRows = new Map<string, CsvImageRow[]>();
    for (const r of rows) {
      if (!r.some((v) => v !== "")) continue;
      let pagePath = pathCol >= 0 ? (r[pathCol] ?? "") : "";
      if (!pagePath && urlCol >= 0) {
        try {
          pagePath = new URL(r[urlCol]).pathname;
        } catch {
          pagePath = r[urlCol] ?? "";
        }
      }
      const row: CsvImageRow = {
        pagePath,
        imageUrl: r[imageCol] ?? "",
        altText: altCol >= 0 ? (r[altCol] ?? "").trim() : "",
        caption: capCol >= 0 ? (r[capCol] ?? "").trim() : "",
        edsImagePath: edsCol >= 0 ? (r[edsCol] ?? "").trim() : "",
      };
      const key = pageKeyFromCsvPath(pagePath);
      const list = fileRows.get(key);
      if (list) list.push(row);
      else fileRows.set(key, [row]);
    }
    for (const [key, list] of fileRows) if (!byPage.has(key)) byPage.set(key, list);
  }
  return byPage;
}

// ---------- main ----------

/**
 * Detects a site path prefix on live page keys ("/fr/who-we-are", and "/fr" for the home page) and
 * removes it when that matches more package pages. Returns the input unchanged otherwise.
 */
export function stripLivePathPrefix(rowsByPage: Map<string, CsvImageRow[]>, pageFiles: Map<string, unknown>): Map<string, CsvImageRow[]> {
  const keys = [...rowsByPage.keys()];
  const matched = (ks: string[]) => ks.filter((k) => pageFiles.has(k)).length;
  const firstSegments = new Map<string, number>();
  for (const k of keys) {
    const seg = k.split("/")[1];
    if (seg) firstSegments.set(seg, (firstSegments.get(seg) ?? 0) + 1);
  }
  const [prefix, count] = [...firstSegments].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!prefix || count! < keys.length * 0.5) return rowsByPage;
  const strip = (k: string) => (k === `/${prefix}` ? "/index" : k.startsWith(`/${prefix}/`) ? k.slice(prefix.length + 1) : k);
  if (matched(keys.map(strip)) <= matched(keys)) return rowsByPage;
  const out = new Map<string, CsvImageRow[]>();
  for (const [k, rows] of rowsByPage) {
    const nk = strip(k);
    out.set(nk, [...(out.get(nk) ?? []), ...rows]);
  }
  return out;
}

export function updatePackage(
  packageZip: Uint8Array,
  rowsByPage: Map<string, CsvImageRow[]>,
  assets: AssetMap,
  options: UpdateOptions = DEFAULT_UPDATE_OPTIONS,
  /** Extra report rows (e.g. pages that are not on the live site), listed first in the report. */
  extraChanges: ChangeRow[] = [],
): UpdateResult {
  const entries = unzipSync(packageZip);
  const names = Object.keys(entries);
  const { roots, pages } = listPackagePages(names, options.siteRoot);
  if (roots.length === 0) throw new Error("Could not identify a language root. Include an index page or use a country/language or language-masters/language content path. For other layouts, specify --site-root with the CLI.");

  // Page key (path after the language root) -> package files (one per language root).
  const pageFiles = new Map<string, string[]>();
  const fragmentFiles: string[] = [];
  const pathOfFile = new Map<string, string>();
  for (const p of pages) {
    pathOfFile.set(p.file, p.path);
    if (FRAGMENT_NAMES.has(p.path.split("/")[1]?.toLowerCase() ?? "")) {
      fragmentFiles.push(p.file);
      continue;
    }
    const key = p.path.toLowerCase();
    pageFiles.set(key, [...(pageFiles.get(key) ?? []), p.file]);
  }

  // Live paths may carry a site prefix (e.g. "/fr/who-we-are" on www.abbvie.ch/fr). If removing a
  // shared first segment makes more pages match the package, use the paths without it.
  rowsByPage = stripLivePathPrefix(rowsByPage, pageFiles);

  const keyOf = (row: CsvImageRow) => assets.assetKey(row.edsImagePath) ?? assets.assetKey(row.imageUrl);

  const changes: ChangeRow[] = [...extraChanges];
  const modified = new Map<string, string>();
  let pagesMatched = 0;
  let imagesMatched = 0;
  let csvRows = 0;
  for (const rows of rowsByPage.values()) csvRows += rows.length;

  /** Applies edits for one package file and records report rows. */
  const processFile = (file: string, pagePath: string, work: (ctx: FileContext) => void) => {
    const xml = strFromU8(entries[file]);
    const ctx = new FileContext(file, pagePath, xml, scanImageSlots(xml, assets), options, changes);
    work(ctx);
    const out = ctx.apply();
    if (out !== xml) modified.set(file, out);
  };

  // ---- Site chrome: header/footer images repeat (same image + alt) on most live pages. ----
  // They belong to the nav/footer fragments, so they are taken out before pairing page images;
  // otherwise a header image could be paired with the same image used in a page's content.
  type Where = "header" | "footer";
  const chromeIndex = new Map<string, Map<number, Where>>();
  const stats = new Map<string, { pages: Map<string, number[]>; positions: number[] }>();
  for (const [pageKey, rows] of rowsByPage) {
    rows.forEach((row, i) => {
      const key = keyOf(row);
      if (!key) return;
      const statKey = `${key}\u0000${row.altText}`;
      const st = stats.get(statKey) ?? { pages: new Map<string, number[]>(), positions: [] };
      stats.set(statKey, st);
      st.pages.set(pageKey, [...(st.pages.get(pageKey) ?? []), i]);
      st.positions.push(rows.length > 1 ? i / (rows.length - 1) : 0);
    });
  }
  const minPages = Math.max(3, Math.ceil(rowsByPage.size * 0.5));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const st of stats.values()) {
    if (st.pages.size < minPages) continue;
    const perPage = median([...st.pages.values()].map((l) => l.length));
    const where: Where = median(st.positions) < 0.5 ? "header" : "footer";
    for (const [pageKey, idxs] of st.pages) {
      const chrome = chromeIndex.get(pageKey) ?? new Map<number, Where>();
      chromeIndex.set(pageKey, chrome);
      for (const i of where === "header" ? idxs.slice(0, perPage) : idxs.slice(-perPage)) chrome.set(i, where);
    }
  }
  let chromeRows = 0;
  for (const m of chromeIndex.values()) chromeRows += m.size;

  if (options.includeFragments) {
    // Most common live value per asset, from header rows (for nav/header) or footer rows (for footer).
    const votes = { header: new Map(), footer: new Map(), any: new Map() } as Record<
      Where | "any",
      Map<string, Map<string, { row: CsvImageRow; n: number }>>
    >;
    const vote = (bucket: Map<string, Map<string, { row: CsvImageRow; n: number }>>, key: string, row: CsvImageRow) => {
      const byValue = bucket.get(key) ?? new Map();
      bucket.set(key, byValue);
      const v = `${row.altText}\u0000${row.caption}`;
      const entry = byValue.get(v) ?? { row, n: 0 };
      entry.n++;
      byValue.set(v, entry);
    };
    for (const [pageKey, rows] of rowsByPage) {
      const chrome = chromeIndex.get(pageKey);
      rows.forEach((row, i) => {
        const key = keyOf(row);
        if (!key) return;
        vote(votes.any, key, row);
        const where = chrome?.get(i);
        if (where) vote(votes[where], key, row);
      });
    }
    const best = (bucket: Map<string, Map<string, { row: CsvImageRow; n: number }>>, key: string) => {
      const c = bucket.get(key);
      return c ? [...c.values()].sort((a, b) => b.n - a.n)[0].row : undefined;
    };
    for (const file of fragmentFiles) {
      const fragPath = pathOfFile.get(file)!;
      const where: Where = fragPath.toLowerCase().startsWith("/footer") ? "footer" : "header";
      processFile(file, `(fragment) ${fragPath}`, (ctx) => {
        for (const slot of ctx.slots) {
          const row = best(votes[where], slot.assetKey) ?? best(votes.any, slot.assetKey);
          if (!row) continue;
          imagesMatched++;
          ctx.applyRow(slot, row);
        }
      });
    }
  }

  for (const [pageKey, allRows] of rowsByPage) {
    const files = pageFiles.get(pageKey);
    const pagePath = allRows[0].pagePath;
    if (!files?.length) {
      for (const r of allRows) {
        changes.push(
          changeRow({
            pagePath,
            status: "page-not-in-package",
            newAlt: r.altText,
            newCaption: r.caption,
            imageUrl: r.imageUrl,
            edsImagePath: r.edsImagePath,
          }),
        );
      }
      continue;
    }
    pagesMatched++;
    const chrome = chromeIndex.get(pageKey);
    const rows = allRows.filter((_, i) => !chrome?.has(i));
    for (const file of files)
      processFile(file, pagePath, (ctx) => {
        const blockSlots = ctx.slots;

        // Block images: CSV rows and package nodes are paired per asset, in document order.
        for (const row of rows) {
          const assetKey = keyOf(row);
          if (!assetKey) {
            ctx.report(row, "no-asset-match");
            continue;
          }
          const slot = blockSlots.find((s) => !s.used && s.assetKey === assetKey);
          if (!slot) {
            ctx.report(row, "not-found-on-page");
            continue;
          }
          slot.used = true;
          imagesMatched++;
          ctx.applyRow(slot, row);
        }
      });
  }

  // Rebuild the package: unmodified entries keep their original bytes and order.
  const outEntries: Record<string, Uint8Array> = {};
  for (const n of names) outEntries[n] = modified.has(n) ? strToU8(modified.get(n)!) : entries[n];
  const zip = zipSync(outEntries, { level: 6 });

  const byStatus: Record<string, number> = {};
  let fieldsUpdated = 0;
  for (const c of changes) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    if (c.altStatus === "updated") fieldsUpdated++;
    if (c.captionStatus === "updated") fieldsUpdated++;
  }

  const reportCsv = rowsToCsv(
    [
      "Page Path",
      "Status",
      "Alt Old",
      "Alt New",
      "Alt Status",
      "Caption Old",
      "Caption New",
      "Caption Status",
      "Alt Property",
      "Caption Property",
      "Node",
      "Package File",
      "Image URL",
      "EDS image path",
      "Note",
    ],
    changes.map((c) => [
      c.pagePath,
      c.status,
      c.oldAlt,
      c.newAlt,
      c.altStatus,
      c.oldCaption,
      c.newCaption,
      c.captionStatus,
      c.altField,
      c.captionField,
      c.node,
      c.packageFile,
      c.imageUrl,
      c.edsImagePath,
      c.note,
    ]),
  );

  return {
    summary: {
      siteRoot: roots.join(", "),
      packagePages: pages.length,
      csvRows,
      csvPages: rowsByPage.size,
      pagesMatched,
      filesModified: modified.size,
      imagesMatched,
      fieldsUpdated,
      headerFooterRows: chromeRows,
      byStatus,
      fragments: fragmentFiles.map((f) => pathOfFile.get(f)!),
    },
    changes,
    zip,
    reportCsv,
  };
}

/** Collects attribute edits for one XML file and writes report rows. */
class FileContext {
  private edits: { start: number; end: number; text: string }[] = [];
  private written = new Set<string>();

  constructor(
    readonly file: string,
    readonly pagePath: string,
    private xml: string,
    readonly slots: ImageSlot[],
    private options: UpdateOptions,
    private changes: ChangeRow[],
  ) {}

  /** A live image that could not be placed in this file. */
  report(row: CsvImageRow, status: ChangeStatus) {
    this.changes.push(
      changeRow({
        pagePath: this.pagePath,
        packageFile: this.file,
        status,
        newAlt: row.altText,
        newCaption: row.caption,
        imageUrl: row.imageUrl,
        edsImagePath: row.edsImagePath,
      }),
    );
  }

  /** Writes the live alt text and caption to one image node and records a single report row. */
  applyRow(slot: ImageSlot, row: CsvImageRow) {
    const out = changeRow({
      pagePath: this.pagePath,
      packageFile: this.file,
      node: slot.node,
      status: "unchanged",
      newAlt: row.altText,
      newCaption: row.caption,
      imageUrl: row.imageUrl,
      edsImagePath: row.edsImagePath,
    });

    if (this.options.updateAlt) {
      const altField = altFieldFor(slot);
      if (altField) {
        const r = this.setValue(slot, altField, row.altText);
        Object.assign(out, { altField, oldAlt: r.oldText, altStatus: r.status });
      } else {
        Object.assign(out, { altField: "", altStatus: "no-field", note: `component has no alt property for ${slot.field}` });
      }
    }
    const captionField = this.options.updateCaption ? captionFieldFor(slot) : null;
    if (captionField) {
      const r = this.setValue(slot, captionField, row.caption);
      Object.assign(out, { captionField, oldCaption: r.oldText, captionStatus: r.status });
    } else if (this.options.updateCaption && row.caption) {
      Object.assign(out, { captionStatus: "no-field" as FieldStatus });
    }

    if (out.altStatus === "updated" || out.captionStatus === "updated") out.status = "updated";
    else if (out.altStatus === "no-field") out.status = "no-alt-field";
    this.changes.push(out);
  }

  /** Replaces (or adds) one attribute value. Returns the old value and whether anything changed. */
  private setValue(slot: ImageSlot, field: string, newText: string): { oldText: string; status: FieldStatus } {
    const existing = slot.attrs.get(field);
    const oldText = existing ? readDocviewValue(existing.raw) : "";
    // Includes: attribute missing and live value empty (nothing to write). Differences in
    // whitespace only are not changes (live text is whitespace-normalised by the crawler).
    if (oldText.replace(/\s+/g, " ").trim() === newText.replace(/\s+/g, " ").trim()) return { oldText, status: "unchanged" };
    const key = `${slot.node}|${slot.field}|${field}`;
    if (this.written.has(key)) return { oldText, status: "unchanged" };
    this.written.add(key);
    if (existing) this.edits.push({ start: existing.valueStart, end: existing.valueEnd, text: writeDocviewValue(newText) });
    else this.edits.push({ start: slot.insertAt, end: slot.insertAt, text: `${slot.indent}${field}="${writeDocviewValue(newText)}"` });
    return { oldText, status: "updated" };
  }

  apply(): string {
    if (this.edits.length === 0) return this.xml;
    const sorted = [...this.edits].sort((a, b) => b.start - a.start);
    let out = this.xml;
    for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
  }
}
