"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { buildPerPageCsvFiles, buildZip, toCsv } from "@/lib/csv";
import type { AltStatus, ImageRecord } from "@/lib/types";

export type PageStatus = "pending" | "running" | "done" | "skipped" | "error" | "deferred";

export interface PageState {
  url: string;
  path: string;
  status: PageStatus;
  title?: string;
  count?: number;
  message?: string;
  via?: "fetch" | "render";
}

type AltFilter = "all" | AltStatus;

const ICON_MAX_PX = 48;
const ROWS_PER_PAGE = 100;

interface Props {
  images: ImageRecord[];
  setImages: Dispatch<SetStateAction<ImageRecord[]>>;
  pages: PageState[];
  exportKind: "sitemap" | "pages";
  running: boolean;
}

function download(data: BlobPart, type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ResultsView({ images, setImages, pages, exportKind, running }: Props) {
  const [dedupe, setDedupe] = useState(true);
  const [hideIcons, setHideIcons] = useState(false);
  const [hideRepeated, setHideRepeated] = useState(false);
  const [altFilter, setAltFilter] = useState<AltFilter>("all");
  const [captionOnly, setCaptionOnly] = useState(false);
  const [edsFilter, setEdsFilter] = useState<"all" | "mapped" | "unmapped">("all");
  const [search, setSearch] = useState("");
  const [tablePage, setTablePage] = useState(0);

  const donePages = useMemo(() => pages.filter((p) => p.status === "done"), [pages]);
  const multiPage = donePages.length > 1;

  // Images present on most pages are usually header/footer chrome (logos, social icons).
  const repeatedKeys = useMemo(() => {
    const pagesPerImage = new Map<string, Set<string>>();
    for (const img of images) {
      const key = `${img.imageUrl}|${img.altText}`;
      let set = pagesPerImage.get(key);
      if (!set) pagesPerImage.set(key, (set = new Set()));
      set.add(img.pageUrl);
    }
    const threshold = Math.max(3, donePages.length * 0.5);
    const keys = new Set<string>();
    for (const [key, set] of pagesPerImage) if (set.size >= threshold) keys.add(key);
    return keys;
  }, [images, donePages.length]);

  const visible = useMemo(() => {
    const seen = new Set<string>();
    const q = search.trim().toLowerCase();
    return images.filter((img) => {
      if (dedupe) {
        const key = `${img.pageUrl}|${img.imageUrl}|${img.altText}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      if (hideIcons && img.width > 0 && img.height > 0 && img.width <= ICON_MAX_PX && img.height <= ICON_MAX_PX) return false;
      if (hideRepeated && repeatedKeys.has(`${img.imageUrl}|${img.altText}`)) return false;
      if (altFilter !== "all" && img.altStatus !== altFilter) return false;
      if (captionOnly && !img.caption) return false;
      if (edsFilter === "mapped" && !img.edsImagePath) return false;
      if (edsFilter === "unmapped" && img.edsImagePath) return false;
      if (q && ![img.imageUrl, img.altText, img.caption, img.pagePath].some((v) => v.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [images, dedupe, hideIcons, hideRepeated, repeatedKeys, altFilter, captionOnly, edsFilter, search]);

  const stats = useMemo(() => {
    const s = { total: visible.length, present: 0, empty: 0, missing: 0, captions: 0, eds: 0 };
    for (const i of visible) {
      s[i.altStatus]++;
      if (i.caption) s.captions++;
      if (i.edsImagePath) s.eds++;
    }
    return s;
  }, [visible]);

  const pageCount = Math.max(1, Math.ceil(visible.length / ROWS_PER_PAGE));
  const currentPage = Math.min(tablePage, pageCount - 1);
  const rows = visible.slice(currentPage * ROWS_PER_PAGE, (currentPage + 1) * ROWS_PER_PAGE);

  const host = (() => {
    try {
      return new URL(images[0]?.pageUrl ?? "").hostname.replace(/^www\./, "");
    } catch {
      return "images";
    }
  })();
  const stamp = () => new Date().toISOString().slice(0, 10);

  function updateImage(id: string, field: "altText" | "caption", value: string) {
    setImages((prev) =>
      prev.map((img) => {
        if (img.id !== id) return img;
        const next = { ...img, [field]: value };
        if (field === "altText") next.altStatus = value.trim() ? "present" : img.altStatus === "missing" ? "missing" : "empty";
        return next;
      }),
    );
  }

  function downloadCombined() {
    download(toCsv(visible, exportKind === "sitemap" ? "path" : "url"), "text/csv;charset=utf-8", `${host}-image-alt-captions-${stamp()}.csv`);
  }

  function downloadZip() {
    const files = buildPerPageCsvFiles(donePages, visible);
    download(buildZip(files) as Uint8Array<ArrayBuffer>, "application/zip", `${host}-image-alt-captions-${stamp()}.zip`);
  }

  if (images.length === 0) return null;

  return (
    <>
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Images" value={stats.total} tone="slate" />
        <Stat label="With alt text" value={stats.present} tone="emerald" />
        <Stat label="Empty alt" value={stats.empty} tone="amber" />
        <Stat label="Missing alt" value={stats.missing} tone="rose" />
        <Stat label="With caption" value={stats.captions} tone="indigo" />
        <Stat label="EDS image path found" value={stats.eds} tone="emerald" />
      </section>

      <section className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm shadow-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setTablePage(0);
          }}
          placeholder="Search page, URL, alt or caption…"
          className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100"
        />
        <select
          value={altFilter}
          onChange={(e) => {
            setAltFilter(e.target.value as AltFilter);
            setTablePage(0);
          }}
          className="rounded-lg border border-slate-300 px-2 py-1.5 outline-none focus:border-indigo-500"
        >
          <option value="all">All alt statuses</option>
          <option value="present">Has alt text</option>
          <option value="empty">Empty alt (decorative)</option>
          <option value="missing">Missing alt attribute</option>
        </select>
        <select
          value={edsFilter}
          onChange={(e) => {
            setEdsFilter(e.target.value as typeof edsFilter);
            setTablePage(0);
          }}
          className="rounded-lg border border-slate-300 px-2 py-1.5 outline-none focus:border-indigo-500"
        >
          <option value="all">All EDS mappings</option>
          <option value="mapped">EDS path found</option>
          <option value="unmapped">EDS path not found</option>
        </select>
        <Toggle checked={dedupe} onChange={setDedupe} label="Remove duplicates" />
        <Toggle checked={hideIcons} onChange={setHideIcons} label={`Hide icons (≤${ICON_MAX_PX}px)`} />
        {multiPage && <Toggle checked={hideRepeated} onChange={setHideRepeated} label="Hide header/footer images" />}
        <Toggle checked={captionOnly} onChange={setCaptionOnly} label="Only with caption" />
        <div className="ml-auto flex flex-wrap gap-2">
          {exportKind === "sitemap" && (
            <button
              onClick={downloadZip}
              disabled={running || donePages.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <DownloadIcon />
              ZIP · CSV per page ({donePages.length})
            </button>
          )}
          <button
            onClick={downloadCombined}
            disabled={running || visible.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon />
            {exportKind === "sitemap" ? "Combined CSV" : "Download CSV"} ({visible.length.toLocaleString()})
          </button>
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-12 px-4 py-3">#</th>
                <th className="w-28 px-4 py-3">Preview</th>
                {multiPage && <th className="px-4 py-3">Page path</th>}
                <th className="px-4 py-3">Image URL</th>
                <th className="px-4 py-3">Alt text</th>
                <th className="px-4 py-3">Caption</th>
                <th className="px-4 py-3">EDS image path</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((img, i) => (
                <tr key={img.id} className="align-top hover:bg-slate-50/60">
                  <td className="px-4 py-3 text-slate-400">{currentPage * ROWS_PER_PAGE + i + 1}</td>
                  <td className="px-4 py-3">
                    <a
                      href={img.imageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block h-16 w-24 overflow-hidden rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:12px_12px]"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
                    </a>
                  </td>
                  {multiPage && (
                    <td className="min-w-40 max-w-56 px-4 py-3">
                      <a href={img.pageUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-slate-600 hover:text-indigo-600 hover:underline">
                        {img.pagePath}
                      </a>
                    </td>
                  )}
                  <td className="max-w-xs px-4 py-3">
                    <a href={img.imageUrl} target="_blank" rel="noreferrer" className="line-clamp-3 break-all font-mono text-xs text-indigo-600 hover:underline">
                      {img.imageUrl}
                    </a>
                    {img.width > 0 && (
                      <div className="mt-1 text-xs text-slate-400">
                        {img.width}×{img.height}
                      </div>
                    )}
                  </td>
                  <td className="min-w-56 px-4 py-3">
                    <AltBadge status={img.altStatus} />
                    <EditableCell value={img.altText} placeholder="Add alt text…" onChange={(v) => updateImage(img.id, "altText", v)} />
                  </td>
                  <td className="min-w-56 px-4 py-3">
                    {img.captionSource && (
                      <span className="mb-1 inline-block rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-600">
                        {img.captionSource}
                      </span>
                    )}
                    <EditableCell value={img.caption} placeholder="No caption found" onChange={(v) => updateImage(img.id, "caption", v)} />
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    {img.edsImagePath ? (
                      <>
                        <span
                          className={`mb-1 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${img.edsMatch.includes("(") ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}
                        >
                          {img.edsMatch}
                        </span>
                        {/^https?:\/\//.test(img.edsImagePath) ? (
                          <a href={img.edsImagePath} target="_blank" rel="noreferrer" className="line-clamp-3 break-all font-mono text-xs text-indigo-600 hover:underline">
                            {img.edsImagePath}
                          </a>
                        ) : (
                          <span className="line-clamp-3 break-all font-mono text-xs text-slate-600">{img.edsImagePath}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-slate-300">Not found</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-400">No images match the current filters.</p>}
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
            <span>
              Rows {(currentPage * ROWS_PER_PAGE + 1).toLocaleString()}–{Math.min(visible.length, (currentPage + 1) * ROWS_PER_PAGE).toLocaleString()} of{" "}
              {visible.length.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <PagerButton onClick={() => setTablePage(0)} disabled={currentPage === 0} label="«" />
              <PagerButton onClick={() => setTablePage(currentPage - 1)} disabled={currentPage === 0} label="Prev" />
              <span className="px-2">
                {currentPage + 1} / {pageCount}
              </span>
              <PagerButton onClick={() => setTablePage(currentPage + 1)} disabled={currentPage >= pageCount - 1} label="Next" />
              <PagerButton onClick={() => setTablePage(pageCount - 1)} disabled={currentPage >= pageCount - 1} label="»" />
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function PagerButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-slate-300 px-2.5 py-1 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  );
}

function EditableCell({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      rows={Math.min(6, Math.max(2, Math.ceil(value.length / 28)))}
      className="w-full resize-y rounded-lg border border-transparent bg-transparent px-2 py-1 text-slate-700 outline-none transition placeholder:text-slate-300 hover:border-slate-200 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
    />
  );
}

function AltBadge({ status }: { status: AltStatus }) {
  const map = {
    present: ["bg-emerald-50 text-emerald-700", "Has alt"],
    empty: ["bg-amber-50 text-amber-700", "Empty alt"],
    missing: ["bg-rose-50 text-rose-700", "Missing alt"],
  } as const;
  const [cls, label] = map[status];
  return <span className={`mb-1 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>{label}</span>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "slate" | "emerald" | "amber" | "rose" | "indigo" }) {
  const tones = { slate: "text-slate-900", emerald: "text-emerald-600", amber: "text-amber-600", rose: "text-rose-600", indigo: "text-indigo-600" };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className={`text-2xl font-semibold ${tones[tone]}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-slate-600">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded accent-indigo-600" />
      {label}
    </label>
  );
}
