import { strToU8, zipSync } from "fflate";
import type { ImageRecord } from "./types";

export type PageColumn = "url" | "path";

export const EDS_COLUMN = "EDS image path";

function escapeCell(value: string): string {
  let v = value ?? "";
  // Neutralise spreadsheet formula injection from untrusted page content.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Serialises arbitrary rows with the given header (UTF-8 BOM for Excel). */
export function rowsToCsv(header: string[], rows: string[][]): string {
  const lines = [header.map(escapeCell).join(",")];
  for (const r of rows) lines.push(header.map((_, i) => escapeCell(r[i] ?? "")).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function toCsv(rows: ImageRecord[], pageColumn: PageColumn = "url"): string {
  const header = [pageColumn === "path" ? "Page Path" : "Page URL", "Image URL", "Alt Text", "Caption", EDS_COLUMN];
  return rowsToCsv(
    header,
    rows.map((r) => [pageColumn === "path" ? r.pagePath : r.pageUrl, r.imageUrl, r.altText, r.caption, r.edsImagePath ?? ""]),
  );
}

/** Turns a page path into a safe, readable file name, e.g. "/who-we-are/our-principles.html" -> "who-we-are__our-principles.csv". */
export function csvFileNameForPath(pagePath: string): string {
  const [pathname, query = ""] = pagePath.split("?");
  let name = decodeURIComponent(pathname)
    .replace(/\.(html?|aspx?|php|jsp)$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "__");
  if (query) name += `_${query}`;
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, "-").slice(0, 150);
  return `${name || "home"}.csv`;
}

export interface PageForExport {
  url: string;
  path: string;
}

/** Builds a map of file name -> CSV content: one CSV per page plus a combined all-pages CSV. */
export function buildPerPageCsvFiles(pages: PageForExport[], rows: ImageRecord[]): Record<string, string> {
  const byPage = new Map<string, ImageRecord[]>();
  for (const row of rows) {
    const list = byPage.get(row.pageUrl);
    if (list) list.push(row);
    else byPage.set(row.pageUrl, [row]);
  }

  const files: Record<string, string> = {};
  const used = new Set<string>();
  for (const page of pages) {
    let name = csvFileNameForPath(page.path);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/(-\d+)?\.csv$/, `-${n}.csv`);
    used.add(name.toLowerCase());
    files[`pages/${name}`] = toCsv(byPage.get(page.url) ?? [], "path");
  }
  files["all-pages.csv"] = toCsv(rows, "path");
  return files;
}

export function buildZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries, { level: 6 });
}
