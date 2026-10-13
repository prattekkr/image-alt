"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetMapFile, AutoUpdateStreamEvent, UpdatePackageResponse } from "@/lib/types";

type ResultData = UpdatePackageResponse & {
  site?: string;
  pagesInPackage?: number;
  pagesCrawled?: number;
  pagesNotLive?: number;
  liveCsvName?: string;
  liveCsv?: string;
};

async function readNdjson(res: Response, onEvent: (e: AutoUpdateStreamEvent) => void) {
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
      if (line) onEvent(JSON.parse(line) as AutoUpdateStreamEvent);
    }
  }
}

const STATUS_STYLES: Record<string, string> = {
  updated: "bg-emerald-50 text-emerald-700",
  unchanged: "bg-slate-100 text-slate-600",
  "not-found-on-page": "bg-amber-50 text-amber-700",
  "page-not-live": "bg-amber-50 text-amber-700",
  "no-asset-match": "bg-rose-50 text-rose-700",
  "no-alt-field": "bg-rose-50 text-rose-700",
  "page-not-in-package": "bg-rose-50 text-rose-700",
};

function download(data: BlobPart, type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FilePicker({
  label,
  hint,
  accept,
  multiple,
  files,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const pick = (list: FileList | null) => {
    if (!list) return;
    const exts = accept.split(",").map((e) => e.trim().toLowerCase());
    const ok = Array.from(list).filter((f) => exts.some((e) => f.name.toLowerCase().endsWith(e)));
    onChange(multiple ? [...files.filter((f) => !ok.some((o) => o.name === f.name)), ...ok] : ok.slice(0, 1));
  };
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      <div
        onClick={() => !disabled && ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) pick(e.dataTransfer.files);
        }}
        className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-5 text-center text-sm transition ${
          dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-white"
        }`}
      >
        {files.length === 0 ? (
          <>
            <p className="font-medium text-slate-700">Drop or click to choose</p>
            <p className="mt-1 text-xs text-slate-400">{hint}</p>
          </>
        ) : (
          <ul className="space-y-1 text-left">
            {files.map((f) => (
              <li key={f.name} className="flex items-center gap-2">
                <span className="truncate font-mono text-xs text-slate-700">{f.name}</span>
                <span className="ml-auto shrink-0 text-xs text-slate-400">{(f.size / 1024).toFixed(0)} KB</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(files.filter((x) => x !== f));
                  }}
                  className="rounded px-1 text-slate-400 hover:text-rose-600"
                  aria-label={`Remove ${f.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={ref}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

export default function PackageUpdater() {
  const [pkg, setPkg] = useState<File[]>([]);
  const [csvs, setCsvs] = useState<File[]>([]);
  const [source, setSource] = useState<"crawl" | "csv">("crawl");
  const [site, setSite] = useState("");
  const [progress, setProgress] = useState<{
    phase: string;
    done: number;
    total: number;
    notLive: number;
    images: number;
    notice: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [assetMaps, setAssetMaps] = useState<AssetMapFile[] | null>(null);
  const [assetMapName, setAssetMapName] = useState("");
  const [opts, setOpts] = useState({ updateAlt: true, updateCaption: true, includeCardImage: true, includeFragments: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  const [statusFilter, setStatusFilter] = useState("updated");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/asset-maps")
      .then((r) => r.json())
      .then((data: { files: AssetMapFile[] }) => {
        if (cancelled) return;
        setAssetMaps(data.files);
        if (data.files[0]) setAssetMapName(data.files[0].name);
      })
      .catch(() => !cancelled && setAssetMaps([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function run() {
    if (!pkg[0]) return setError("Choose the AEM package ZIP.");
    if (source === "csv" && csvs.length === 0) return setError("Choose the CSV(s) with the live alt text and captions.");
    if (source === "crawl" && !site.trim()) return setError("Enter the live site domain, e.g. https://www.abbvie.co.nz");
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const form = new FormData();
      form.append("package", pkg[0]);
      if (assetMapName) form.append("assetMapName", assetMapName);
      for (const [k, v] of Object.entries(opts)) form.append(k, String(v));

      if (source === "csv") {
        for (const f of csvs) form.append("files", f);
        const res = await fetch("/api/update-package", { method: "POST", body: form, signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        setResult(data as UpdatePackageResponse);
      } else {
        form.append("site", site.trim());
        const res = await fetch("/api/auto-update-package", { method: "POST", body: form, signal: controller.signal });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        await readNdjson(res, (event: AutoUpdateStreamEvent) => {
          if (event.type === "phase")
            setProgress((p) => ({ done: 0, total: 0, notLive: 0, images: 0, notice: "", ...p, phase: event.message }));
          else if (event.type === "progress") setProgress((p) => ({ phase: p?.phase ?? "", notice: p?.notice ?? "", ...event }));
          else if (event.type === "notice") setProgress((p) => (p ? { ...p, notice: event.message } : p));
          else if (event.type === "fatal") throw new Error(event.message);
          else if (event.type === "result") setResult(event);
        });
      }
      setStatusFilter("updated");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const rows = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    return result.changes.filter(
      (c) =>
        (statusFilter === "all" || c.status === statusFilter) &&
        (!q || [c.pagePath, c.node, c.oldAlt, c.newAlt, c.oldCaption, c.newCaption, c.imageUrl].some((v) => v.toLowerCase().includes(q))),
    );
  }, [result, statusFilter, search]);

  function downloadPackage() {
    if (!result) return;
    const bytes = Uint8Array.from(atob(result.packageBase64), (c) => c.charCodeAt(0));
    download(bytes, "application/zip", result.packageName);
  }

  const s = result?.summary;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Copies the live site&apos;s image alt text and captions into an AEM content package. Each package page is matched to the live page
        with the same path after the language folder (<span className="font-mono">index</span> → <span className="font-mono">/</span>),
        images by asset. Only alt text and caption values change; the original package is not modified.
      </p>

      <div className="mb-4 inline-flex rounded-xl border border-slate-300 p-0.5 text-sm">
        {(
          [
            ["crawl", "Crawl live site automatically"],
            ["csv", "Use an existing live CSV"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSource(key)}
            disabled={busy}
            className={`rounded-lg px-3 py-1.5 transition ${source === key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <FilePicker
          label="AEM package"
          hint=".zip content package (jcr_root/…)"
          accept=".zip"
          files={pkg}
          onChange={setPkg}
          disabled={busy}
        />
        {source === "crawl" ? (
          <div>
            <label htmlFor="liveSite" className="mb-1.5 block text-sm font-medium text-slate-700">
              Live site domain
            </label>
            <input
              id="liveSite"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              disabled={busy}
              placeholder="https://www.abbvie.co.nz  or  https://www.abbvie.ch/fr"
              className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm outline-none focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-100"
            />
            <p className="mt-1 text-xs text-slate-400">
              Every page in the package is crawled at{" "}
              <span className="font-mono">{site.trim() || "<domain>"}/&lt;path after language&gt;</span>. Pages that are not on the live
              site are only reported.
            </p>
          </div>
        ) : (
          <FilePicker
            label="Live-site CSV(s)"
            hint="all-pages.csv, pages/*.csv or the export ZIP, with EDS image path"
            accept=".csv,.zip"
            multiple
            files={csvs}
            onChange={setCsvs}
            disabled={busy}
          />
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
        <div>
          <label htmlFor="pkgAssetMap" className="mb-1.5 block text-sm font-medium text-slate-700">
            Asset map
          </label>
          {assetMaps && assetMaps.length > 0 ? (
            <select
              id="pkgAssetMap"
              value={assetMapName}
              onChange={(e) => setAssetMapName(e.target.value)}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 outline-none focus:border-indigo-500"
            >
              {assetMaps.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-amber-700">{assetMaps === null ? "Loading…" : "No asset map in the input folder"}</p>
          )}
        </div>
        {(
          [
            ["updateAlt", "Alt text"],
            ["updateCaption", "Captions"],
            ["includeFragments", "Header/footer fragments"],
            ["includeCardImage", "Page teaser (cardImage) alt"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="inline-flex cursor-pointer select-none items-center gap-2 pb-2 text-slate-600">
            <input
              type="checkbox"
              checked={opts[key]}
              onChange={(e) => setOpts((o) => ({ ...o, [key]: e.target.checked }))}
              disabled={busy}
              className="h-4 w-4 accent-indigo-600"
            />
            {label}
          </label>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy || !pkg[0] || (source === "csv" ? csvs.length === 0 : !site.trim())}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-200 border-t-white" />}
          {busy ? "Updating package…" : "Update package"}
        </button>
        {busy && source === "crawl" && (
          <button
            onClick={() => abortRef.current?.abort()}
            className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700"
          >
            Stop
          </button>
        )}
        {result && !busy && (
          <>
            <button
              onClick={downloadPackage}
              className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              Download {result.packageName}
            </button>
            <button
              onClick={() => download(result.reportCsv, "text/csv;charset=utf-8", result.reportName)}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Download report CSV
            </button>
            {result.liveCsv && (
              <button
                onClick={() => download(result.liveCsv!, "text/csv;charset=utf-8", result.liveCsvName ?? "live-images.csv")}
                className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Download live CSV
              </button>
            )}
          </>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      {busy && source === "crawl" && progress && (
        <div className="mt-4 rounded-xl border border-slate-200 p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-slate-700">{progress.phase}</span>
            {progress.total > 0 && (
              <span className="text-slate-500">
                {progress.done} / {progress.total} pages · {progress.images.toLocaleString()} images · {progress.notLive} not live
              </span>
            )}
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-300"
              style={{ width: `${progress.total ? pct : 3}%` }}
            />
          </div>
          {progress.notice && <p className="mt-2 text-xs text-amber-700">{progress.notice}</p>}
        </div>
      )}

      {result && s && (
        <div className="mt-5 space-y-3">
          <p className="text-xs text-slate-500">
            {result.site && (
              <>
                Live site <span className="font-mono text-slate-700">{result.site}</span> ·{" "}
              </>
            )}
            Language root <span className="font-mono text-slate-700">{s.siteRoot}</span> · {s.packagePages} package pages · fragments{" "}
            {s.fragments.join(", ") || "none"} · asset map {result.assetMap}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {result.pagesInPackage !== undefined ? (
              <>
                <Mini label="Package pages crawled" value={result.pagesInPackage} />
                <Mini label="Found on live site" value={result.pagesCrawled ?? 0} />
                <Mini
                  label="Not on live site"
                  value={result.pagesNotLive ?? 0}
                  tone={result.pagesNotLive ? "text-amber-600" : "text-slate-900"}
                />
              </>
            ) : (
              <>
                <Mini label="Live pages in CSV" value={s.csvPages} />
                <Mini
                  label="Found in package"
                  value={s.pagesMatched}
                  tone={s.pagesMatched < s.csvPages ? "text-amber-600" : "text-slate-900"}
                />
              </>
            )}
            <Mini label="Images matched" value={s.imagesMatched} />
            <Mini label="Fields updated" value={s.fieldsUpdated} tone="text-emerald-600" />
            <Mini label="Files modified" value={s.filesModified} />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {["all", ...Object.keys(s.byStatus)].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`rounded-md px-2 py-1 transition ${statusFilter === st ? "ring-2 ring-indigo-500" : ""} ${STATUS_STYLES[st] ?? "bg-slate-100 text-slate-700"}`}
              >
                {st} ({st === "all" ? result.changesTotal : s.byStatus[st]})
              </button>
            ))}
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search page, node or text…"
              className="ml-auto w-60 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
            />
          </div>

          <div className="max-h-[32rem] overflow-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Page</th>
                  <th className="px-3 py-2">Node</th>
                  <th className="px-3 py-2">Alt old</th>
                  <th className="px-3 py-2">Alt new</th>
                  <th className="px-3 py-2">Caption old</th>
                  <th className="px-3 py-2">Caption new</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, 1000).map((c, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLES[c.status] ?? "bg-slate-100"}`}>{c.status}</span>
                      {c.note && <div className="mt-1 text-[10px] text-slate-400">{c.note}</div>}
                    </td>
                    <td className="max-w-48 break-all px-3 py-2 font-mono text-slate-600">{c.pagePath}</td>
                    <td className="max-w-56 break-all px-3 py-2 font-mono text-slate-500">
                      {c.node ? c.node.split("/").slice(-2).join("/") : c.imageUrl.split("/").pop()}
                      {(c.altField || c.captionField) && (
                        <div className="text-[10px] text-slate-400">{[c.altField, c.captionField].filter(Boolean).join(" · ")}</div>
                      )}
                    </td>
                    <ValueCell value={c.oldAlt} muted show={!!c.altField} />
                    <ValueCell value={c.newAlt} changed={c.altStatus === "updated"} show />
                    <ValueCell value={c.oldCaption} muted show={!!c.captionField} />
                    <ValueCell
                      value={c.newCaption}
                      changed={c.captionStatus === "updated"}
                      show={!!c.captionField || !c.node}
                      note={c.captionStatus === "no-field" ? "no caption property" : undefined}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-400">No rows for this filter.</p>}
            {rows.length > 1000 && (
              <p className="px-3 py-2 text-xs text-slate-400">Showing 1,000 of {rows.length}. The report CSV has every row.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ValueCell({
  value,
  show,
  muted,
  changed,
  note,
}: {
  value: string;
  show: boolean;
  muted?: boolean;
  changed?: boolean;
  note?: string;
}) {
  if (!show) return <td className="px-3 py-2 text-slate-300">–</td>;
  return (
    <td className={`px-3 py-2 ${muted ? "text-slate-500" : changed ? "font-medium text-emerald-700" : "text-slate-800"}`}>
      {value || <span className="font-normal text-slate-300">(empty)</span>}
      {note && <div className="text-[10px] font-normal text-slate-400">{note}</div>}
    </td>
  );
}

function Mini({ label, value, tone = "text-slate-900" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className={`text-xl font-semibold ${tone}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
