import { DEFAULT_UPDATE_OPTIONS, readCsvImageRows, updatePackage } from "@/lib/aemPackage";
import type { UpdatePackageResponse } from "@/lib/types";
import { assetMapFromForm, csvFilesFromUploads } from "@/lib/uploads";

export const maxDuration = 300;

const MAX_PREVIEW_ROWS = 5000;

/**
 * Copies live-site alt text and captions into an AEM content package.
 * multipart/form-data fields:
 *   package        the AEM package ZIP
 *   files          crawl CSV(s) or a ZIP of them (needs Page Path/URL, Image URL, Alt Text, Caption, EDS image path)
 *   assetMapName / assetMapFile   optional asset map selection (see /api/map-eds)
 *   updateAlt, updateCaption, includeCardImage, includeFragments   "true" | "false"
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const pkg = form.get("package");
  if (!(pkg instanceof File) || pkg.size === 0 || !/\.zip$/i.test(pkg.name)) {
    return Response.json({ error: "Upload the AEM package (.zip)" }, { status: 400 });
  }
  const uploads = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (uploads.length === 0) return Response.json({ error: "Upload the CSV(s) with the live alt text and captions" }, { status: 400 });

  const csvs = await csvFilesFromUploads(uploads);
  if ("error" in csvs) return Response.json({ error: csvs.error }, { status: 400 });
  // Prefer the combined CSV so each page's rows come from one file, in page order.
  csvs.sort((a, b) => Number(/all-pages\.csv$/i.test(b.name)) - Number(/all-pages\.csv$/i.test(a.name)));
  const rowsByPage = readCsvImageRows(csvs);
  if (rowsByPage.size === 0) {
    return Response.json({ error: 'No usable CSV rows. CSVs need "Page Path" (or "Page URL") and "Image URL" columns.' }, { status: 400 });
  }

  const asset = await assetMapFromForm(form);
  if ("error" in asset) return Response.json({ error: asset.error }, { status: 400 });

  const flag = (name: string, fallback: boolean) => {
    const v = form.get(name);
    return v === null ? fallback : v === "true";
  };

  try {
    const result = updatePackage(new Uint8Array(await pkg.arrayBuffer()), rowsByPage, asset.map, {
      updateAlt: flag("updateAlt", DEFAULT_UPDATE_OPTIONS.updateAlt),
      updateCaption: flag("updateCaption", DEFAULT_UPDATE_OPTIONS.updateCaption),
      includeCardImage: flag("includeCardImage", DEFAULT_UPDATE_OPTIONS.includeCardImage),
      includeFragments: flag("includeFragments", DEFAULT_UPDATE_OPTIONS.includeFragments),
    });
    const base = pkg.name.replace(/\.zip$/i, "");
    const response: UpdatePackageResponse = {
      assetMap: asset.name,
      summary: result.summary,
      changes: result.changes.slice(0, MAX_PREVIEW_ROWS),
      changesTotal: result.changes.length,
      packageName: `${base}-alt-updated.zip`,
      packageBase64: Buffer.from(result.zip).toString("base64"),
      reportName: `${base}-alt-update-report.csv`,
      reportCsv: result.reportCsv,
    };
    return Response.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
