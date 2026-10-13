import { AssetMap, inputFilePath, loadAssetMap } from "./assetMap";

/**
 * Resolves the asset map for an upload request: an uploaded "assetMapFile" wins, then "assetMapName"
 * (a CSV in ./input), then the default asset map. Returns an error message instead of throwing.
 */
export async function assetMapFromForm(form: FormData): Promise<{ map: AssetMap; name: string } | { error: string }> {
  try {
    const uploaded = form.get("assetMapFile");
    const chosenName = form.get("assetMapName");
    let map: AssetMap;
    let name: string;
    if (uploaded instanceof File && uploaded.size > 0) {
      map = AssetMap.fromCsv(await uploaded.text());
      name = `${uploaded.name} (uploaded)`;
    } else {
      let explicit: string | undefined;
      if (typeof chosenName === "string" && chosenName) {
        const resolved = await inputFilePath(chosenName);
        if (!resolved) return { error: `Asset map "${chosenName}" not found in the input folder` };
        explicit = resolved;
      }
      const loaded = await loadAssetMap(explicit);
      if (!loaded) return { error: "No asset map found. Put one in the input folder or upload it here." };
      map = loaded.map;
      name = loaded.file.split(/[\\/]/).pop()!;
    }
    if (map.size === 0) return { error: `"${name}" has no usable rows (expected columns path, scene7File, openApiUrl…)` };
    return { map, name };
  } catch (err) {
    return { error: `Could not read the asset map: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Expands uploaded .csv/.zip files into CSV texts (ZIP folder paths kept, Windows backslashes normalised). */
export async function csvFilesFromUploads(uploads: File[]): Promise<{ name: string; text: string }[] | { error: string }> {
  const { strFromU8, unzipSync } = await import("fflate");
  const out: { name: string; text: string }[] = [];
  for (const file of uploads) {
    if (/\.zip$/i.test(file.name)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      } catch {
        return { error: `"${file.name}" is not a valid ZIP file` };
      }
      for (const [rawName, data] of Object.entries(entries)) {
        const name = rawName.replace(/\\/g, "/");
        if (/\.csv$/i.test(name) && !name.startsWith("__MACOSX/")) out.push({ name, text: strFromU8(data) });
      }
    } else if (/\.csv$/i.test(file.name)) {
      out.push({ name: file.name, text: await file.text() });
    }
  }
  return out;
}
