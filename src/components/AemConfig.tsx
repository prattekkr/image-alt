"use client";

import { useState } from "react";
import type { AemConfigInput, ConfigPreviewEntry, ConfigResult } from "@/lib/aemConfig";
import { isConfigEnvironment, saveConfigData, type ConfigEnvironment } from "@/lib/aemConfigMapping";

export default function AemConfig() {
  const [input, setInput] = useState<AemConfigInput>({ author: "", username: "", password: "", root: "/content/abbvie-nextgen-eds/corporate/abbvie-com" });
  const [environment, setEnvironment] = useState<ConfigEnvironment>("prod");
  const [entries, setEntries] = useState<ConfigPreviewEntry[] | null>(null);
  const [results, setResults] = useState<ConfigResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function saveConfig() {
    setError("");
    setBusy(true);
    try {
      const config = saveConfigData(input.root, environment, entries ?? []);
      const response = await fetch("/api/aem-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-config", config }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save config.");
      const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `aem-ab-config-${environment}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Saved ${data.saved} on the server and downloaded a backup. This file will be used automatically on the next discovery. Author URL and credentials are not included.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save config.");
    } finally {
      setBusy(false);
    }
  }

  async function run(action: "preview" | "apply") {
    if (action === "apply" && (!entries?.length || entries.some((entry) => !entry.value.trim()))) {
      setError("Enter a Value for every ab-config page before applying.");
      return;
    }
    setBusy(true);
    setError("");
    setResults([]);
    setNotice("");
    try {
      const response = await fetch("/api/aem-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, environment, action, ...(action === "apply" ? { entries } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AEM request failed.");
      if (action === "preview") {
        setEntries(data.entries);
        setNotice(data.mappingSource === "sites.json"
          ? "No saved config found. Values populated from sites.json."
          : `Automatically used ${data.mappingSource} for ${data.entries.filter((entry: ConfigPreviewEntry) => entry.mappingStatus === "saved").length} of ${data.pages.length} pages found on this Author. Other pages use sites.json or need manual values.`);
      }
      else {
        setResults(data.results);
        setInput((previous) => ({ ...previous, password: "" }));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "AEM request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Find all ab-config pages under a content root using Query Builder, then create a row under each page&apos;s jcr:content.
        Query the selected Author first. Values for <strong>liveDomainToCacheIndex</strong> are then filled automatically from aem-ab-config-dev.json, with sites.json used for pages without a saved mapping.
        Select Dev (www-d1), Test (www-t1), QA (www-q1) or Prod (original domain), then find pages. No config file selection is needed.
        Review or edit each domain, fill any unmatched rows, then apply all entries in one go.
        Existing entries with this Key are skipped, not overwritten. No other content is changed.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Environment
          <select
            value={environment}
            disabled={busy}
            onChange={(event) => {
              setError("");
              const target = event.target.value;
              if (!isConfigEnvironment(target)) {
                setError("Choose Dev, Test, QA or Prod.");
                return;
              }
              setEnvironment(target);
              setEntries(null);
              setResults([]);
              setNotice("");
            }}
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
          >
            <option value="dev">Dev - https://www-d1.domain</option>
            <option value="test">Test - https://www-t1.domain</option>
            <option value="qa">QA - https://www-q1.domain</option>
            <option value="prod">Prod - original domain from sites.json</option>
          </select>
        </label>
        {([
          ["author", "AEM Author URL", "https://author.example.com"],
          ["root", "Content root", "/content/abbvie-nextgen-eds/corporate/abbvie-com"],
          ["username", "Basic Auth username", ""],
          ["password", "Basic Auth password", ""],
        ] as const).map(([key, label, placeholder]) => (
          <label key={key} className="block text-sm font-medium text-slate-700">
            {label}
            <input
              type={key === "password" ? "password" : "text"}
              autoComplete="off"
              value={input[key]}
              placeholder={placeholder}
              disabled={busy}
              onChange={(event) => {
                setInput((previous) => ({ ...previous, [key]: event.target.value }));
                if (key !== "password") {
                  setEntries(null);
                  setNotice("");
                }
                setResults([]);
              }}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Credentials are not saved. Use an account with Query Builder read and node-create permissions. HTTPS is required except for local AEM.
        Each page receives its own entered Value. Review all entries before applying. Avoid concurrent runs on the same root.
      </p>
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} onClick={() => run("preview")} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Working..." : "Find ab-config pages"}
        </button>
        <button disabled={busy || !entries?.length || entries.some((entry) => !entry.value.trim()) || !input.author || !input.username || !input.password} onClick={() => run("apply")} className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          Apply all {entries?.length ?? 0} values
        </button>
        <button disabled={busy || !entries?.length || entries.some((entry) => !entry.value.trim())} onClick={saveConfig} className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">
          Save config
        </button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-700">{notice}</p>}
      {entries && (
        <div className="max-h-96 overflow-auto rounded-xl border border-slate-200 p-4 text-sm">
          <p className="mb-2 font-medium">{entries.length} ab-config pages found ({environment}){entries.length === 0 ? ". No changes will be made." : ". Review the auto-populated values:"}</p>
          {entries.some((entry) => !entry.value.trim()) && (
            <p role="status" className="mb-3 rounded-lg bg-amber-50 p-2 text-amber-800">
              {entries.filter((entry) => !entry.value.trim()).length} pages need manual values: no unique saved-config or sites.json mapping was found.
            </p>
          )}
          <div className="space-y-3">
            {entries.map((entry, index) => (
              <label key={entry.page} className="block">
                <span className="break-all font-mono text-xs text-slate-600">{entry.page}</span>
                <span className={`block text-xs ${entry.mappingStatus === "matched" || entry.mappingStatus === "saved" ? "text-slate-500" : "text-amber-700"}`}>
                  {entry.mappingStatus === "saved" ? `Saved mapping for ${environment} (editable)` : entry.mappingStatus === "matched" ? `Domain from sites.json for ${environment} (editable)` : entry.mappingStatus === "ambiguous" ? "Conflicting domains in sites.json; enter Value manually" : "No matching contentPath in sites.json; enter Value manually"}
                </span>
                <input
                  aria-label={`liveDomainToCacheIndex Value for ${entry.page}`}
                  value={entry.value}
                  placeholder="Enter liveDomainToCacheIndex Value"
                  disabled={busy}
                  onChange={(event) => {
                    setEntries((previous) => previous?.map((row, rowIndex) => rowIndex === index ? { ...row, value: event.target.value } : row) ?? null);
                    setResults([]);
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
                />
              </label>
            ))}
          </div>
        </div>
      )}
      {results.length > 0 && (
        <div className="overflow-auto rounded-xl border border-slate-200">
          <p className="p-3 text-sm">
            Created: {results.filter((r) => r.status === "created").length} | Already exists: {results.filter((r) => r.status === "exists").length} | Failed: {results.filter((r) => r.status === "failed").length}
          </p>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50"><tr>{["Page", "Status", "Node", "Details"].map((title) => <th key={title} className="p-3">{title}</th>)}</tr></thead>
            <tbody>{results.map((row) => (
              <tr key={row.page} className="border-t border-slate-100 align-top">
                <td className="break-all p-3 font-mono">{row.page}</td>
                <td className={`p-3 ${row.status === "failed" ? "text-rose-700" : "text-emerald-700"}`}>{row.status}</td>
                <td className="break-all p-3 font-mono">{row.node}</td>
                <td className="p-3">{row.message}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
