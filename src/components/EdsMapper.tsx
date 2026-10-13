"use client";

import { useEffect, useRef, useState } from "react";
import { strToU8, zipSync } from "fflate";
import type { AssetMapFile, MapEdsResponse } from "@/lib/types";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function download(data: BlobPart, type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function EdsMapper() {
  const [files, setFiles] = useState<File[]>([]);
  const [assetMaps, setAssetMaps] = useState<AssetMapFile[] | null>(null);
  const [assetMapName, setAssetMapName] = useState("");
  const [assetMapUpload, setAssetMapUpload] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MapEdsResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapInputRef = useRef<HTMLInputElement>(null);

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

  function addFiles(list: FileList | null) {
    if (!list) return;
    const accepted = Array.from(list).filter((f) => /\.(csv|zip)$/i.test(f.name));
    if (accepted.length < list.length) setError("Only .csv and .zip files are supported; other files were ignored.");
    else setError(null);
    setResult(null);
    setFiles((prev) => {
      const byName = new Map(prev.map((f) => [f.name, f]));
      for (const f of accepted) byName.set(f.name, f);
      return [...byName.values()];
    });
  }

  async function run() {
    if (files.length === 0) return setError("Choose at least one CSV or ZIP file.");
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      if (assetMapUpload) form.append("assetMapFile", assetMapUpload);
      else if (assetMapName) form.append("assetMapName", assetMapName);
      const res = await fetch("/api/map-eds", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setResult(data as MapEdsResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const outputs = result?.files.filter((f) => f.content !== undefined) ?? [];
  const csvOutputs = outputs.filter((f) => !f.passthrough);

  function downloadResult() {
    if (!result) return;
    // A single uploaded CSV comes back as a CSV with the same name; everything else as a ZIP.
    if (files.length === 1 && /\.csv$/i.test(files[0].name) && csvOutputs.length === 1) {
      download(csvOutputs[0].content!, "text/csv;charset=utf-8", files[0].name);
      return;
    }
    const entries: Record<string, Uint8Array> = {};
    for (const f of outputs) entries[f.name] = strToU8(f.content!);
    const zipName =
      files.length === 1 && /\.zip$/i.test(files[0].name) ? files[0].name.replace(/\.zip$/i, "-eds.zip") : "csv-with-eds-image-path.zip";
    download(zipSync(entries, { level: 6 }) as Uint8Array<ArrayBuffer>, "application/zip", zipName);
  }

  const notFound = result ? result.totals.rows - result.totals.mapped : 0;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Already exported CSVs? Upload them (or the ZIP) and get them back with an{" "}
        <span className="font-medium text-slate-700">EDS image path</span> column. Nothing is re-crawled, and all existing columns stay as
        they are.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
          dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-white"
        }`}
      >
        <svg viewBox="0 0 24 24" className="mb-2 h-8 w-8 text-indigo-500" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        <p className="text-sm font-medium text-slate-700">Drop CSV files or a ZIP here, or click to browse</p>
        <p className="mt-1 text-xs text-slate-400">
          Each CSV needs an &quot;Image URL&quot; column. ZIPs keep their folder structure (e.g. pages/*.csv).
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".csv,.zip"
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 px-3 py-2">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                {f.name.split(".").pop()}
              </span>
              <span className="truncate font-mono text-xs text-slate-700">{f.name}</span>
              <span className="ml-auto shrink-0 text-xs text-slate-400">{formatBytes(f.size)}</span>
              <button
                onClick={() => {
                  setFiles((prev) => prev.filter((x) => x !== f));
                  setResult(null);
                }}
                disabled={busy}
                className="shrink-0 rounded px-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                aria-label={`Remove ${f.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="assetMap" className="mb-1.5 block text-sm font-medium text-slate-700">
            Asset map (from the input folder)
          </label>
          {assetMaps === null ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : assetMaps.length === 0 ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              No CSV in the input folder. Upload an asset map instead.
            </p>
          ) : (
            <select
              id="assetMap"
              value={assetMapName}
              onChange={(e) => setAssetMapName(e.target.value)}
              disabled={busy || !!assetMapUpload}
              className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-50"
            >
              {assetMaps.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} ({formatBytes(m.sizeBytes)})
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">…or upload a different asset map</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => mapInputRef.current?.click()}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Choose CSV…
            </button>
            {assetMapUpload ? (
              <>
                <span className="truncate font-mono text-xs text-slate-700">{assetMapUpload.name}</span>
                <button onClick={() => setAssetMapUpload(null)} className="text-xs text-rose-600 hover:underline">
                  remove
                </button>
              </>
            ) : (
              <span className="text-xs text-slate-400">Columns: path, scene7File, openApiUrl, …</span>
            )}
            <input
              ref={mapInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                setAssetMapUpload(e.target.files?.[0] ?? null);
                setResult(null);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy || files.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-200 border-t-white" />}
          {busy ? "Adding EDS image path…" : "Add EDS image path column"}
        </button>
        {result && (
          <button
            onClick={downloadResult}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
            Download{" "}
            {files.length === 1 && /\.csv$/i.test(files[0].name) && csvOutputs.length === 1 ? "CSV" : `ZIP (${csvOutputs.length} CSVs)`}
          </button>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      {result && (
        <div className="mt-5 space-y-3">
          <p className="text-xs text-slate-500">
            Used asset map <span className="font-medium text-slate-700">{result.assetMap.name}</span> (
            {result.assetMap.assets.toLocaleString()} assets)
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="CSV files updated" value={result.totals.files} />
            <MiniStat label="Rows" value={result.totals.rows} />
            <MiniStat label="EDS image path found" value={result.totals.mapped} tone="text-emerald-600" />
            <MiniStat label="Not found" value={notFound} tone={notFound ? "text-rose-600" : "text-slate-900"} />
          </div>
          {Object.keys(result.totals.byMethod).length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(result.totals.byMethod).map(([method, n]) => (
                <span key={method} className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700">
                  matched by {method}: {n.toLocaleString()}
                </span>
              ))}
            </div>
          )}
          {result.files.some((f) => f.skipped) && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {result.files
                .filter((f) => f.skipped)
                .map((f) => (
                  <div key={f.name}>
                    Skipped <span className="font-mono">{f.name}</span>: {f.skipped}
                  </div>
                ))}
            </div>
          )}
          {result.unmatchedTotal > 0 && (
            <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <summary className="cursor-pointer select-none text-slate-600">
                {result.unmatchedTotal} unique image{result.unmatchedTotal === 1 ? "" : "s"} not found in the asset map
              </summary>
              <ul className="mt-2 max-h-60 space-y-1 overflow-auto">
                {result.unmatched.map((u) => (
                  <li key={u} className="break-all font-mono text-xs text-slate-600">
                    {u}
                  </li>
                ))}
                {result.unmatchedTotal > result.unmatched.length && (
                  <li className="text-xs text-slate-400">…and {result.unmatchedTotal - result.unmatched.length} more</li>
                )}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, tone = "text-slate-900" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className={`text-xl font-semibold ${tone}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
