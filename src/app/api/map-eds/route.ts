import { strFromU8, unzipSync } from "fflate";
import { AssetMap, inputFilePath, loadAssetMap } from "@/lib/assetMap";
import { addEdsColumn } from "@/lib/edsCsv";
import type { MapEdsResponse } from "@/lib/types";

export const maxDuration = 300;

const MAX_UNMATCHED = 500;

/**
 * Adds the "EDS image path" column to already-exported CSVs.
 * multipart/form-data fields:
 *   files          one or more .csv or .zip files (e.g. the "CSV per page" export)
 *   assetMapName   optional, name of a CSV in ./input to use as the asset map
 *   assetMapFile   optional, an uploaded asset map CSV (takes precedence)
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const uploads = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (uploads.length === 0) return Response.json({ error: "Upload at least one .csv or .zip file" }, { status: 400 });

  let map: AssetMap;
  let assetMapName: string;
  try {
    const uploadedMap = form.get("assetMapFile");
    const chosenName = form.get("assetMapName");
    if (uploadedMap instanceof File && uploadedMap.size > 0) {
      map = AssetMap.fromCsv(await uploadedMap.text());
      assetMapName = `${uploadedMap.name} (uploaded)`;
    } else {
      let explicit: string | undefined;
      if (typeof chosenName === "string" && chosenName) {
        const resolved = await inputFilePath(chosenName);
        if (!resolved) return Response.json({ error: `Asset map "${chosenName}" not found in the input folder` }, { status: 400 });
        explicit = resolved;
      }
      const loaded = await loadAssetMap(explicit);
      if (!loaded) {
        return Response.json({ error: "No asset map found. Put one in the input folder or upload it here." }, { status: 400 });
      }
      map = loaded.map;
      assetMapName = loaded.file.split(/[\\/]/).pop()!;
    }
  } catch (err) {
    return Response.json({ error: `Could not read the asset map: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
  }
  if (map.size === 0) {
    return Response.json({ error: `"${assetMapName}" has no usable rows (expected columns path, scene7File, openApiUrl…)` }, { status: 400 });
  }

  // Expand ZIPs into their CSV entries (keeping folder structure); keep other text files as-is.
  const inputs: { name: string; text: string; passthrough?: boolean }[] = [];
  for (const file of uploads) {
    if (/\.zip$/i.test(file.name)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      } catch {
        return Response.json({ error: `"${file.name}" is not a valid ZIP file` }, { status: 400 });
      }
      for (const [rawName, data] of Object.entries(entries)) {
        // Windows' built-in "Compress" can store paths with backslashes.
        const name = rawName.replace(/\\/g, "/");
        if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
        if (/\.csv$/i.test(name)) inputs.push({ name, text: strFromU8(data) });
        else if (/\.txt$/i.test(name)) inputs.push({ name, text: strFromU8(data), passthrough: true });
      }
    } else if (/\.csv$/i.test(file.name)) {
      inputs.push({ name: file.name, text: await file.text() });
    }
  }
  if (!inputs.some((i) => !i.passthrough)) return Response.json({ error: "No CSV files found in the upload" }, { status: 400 });

  const response: MapEdsResponse = {
    assetMap: { name: assetMapName, assets: map.size },
    files: [],
    totals: { files: 0, rows: 0, mapped: 0, byMethod: {} },
    unmatched: [],
    unmatchedTotal: 0,
  };
  const unmatched = new Set<string>();

  for (const input of inputs) {
    if (input.passthrough) {
      response.files.push({ name: input.name, content: input.text, rows: 0, mapped: 0, passthrough: true });
      continue;
    }
    const result = addEdsColumn(input.text, map);
    if (!result) {
      response.files.push({ name: input.name, rows: 0, mapped: 0, skipped: 'No "Image URL" column' });
      continue;
    }
    response.files.push({ name: input.name, content: result.csv, rows: result.rows, mapped: result.mapped });
    response.totals.files++;
    response.totals.rows += result.rows;
    response.totals.mapped += result.mapped;
    for (const [method, n] of Object.entries(result.byMethod)) {
      response.totals.byMethod[method] = (response.totals.byMethod[method] ?? 0) + n;
    }
    for (const u of result.unmatched) unmatched.add(u);
  }
  response.unmatchedTotal = unmatched.size;
  response.unmatched = [...unmatched].slice(0, MAX_UNMATCHED);

  return Response.json(response, { headers: { "Cache-Control": "no-store" } });
}
