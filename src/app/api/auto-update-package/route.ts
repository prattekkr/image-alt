import { DEFAULT_UPDATE_OPTIONS } from "@/lib/aemPackage";
import { autoUpdatePackage, normalizeSite, type AutoUpdateEvent } from "@/lib/autoUpdate";
import type { AutoUpdateStreamEvent } from "@/lib/types";
import { assetMapFromForm } from "@/lib/uploads";

export const maxDuration = 800;

const MAX_PREVIEW_ROWS = 5000;

/**
 * One-step package update. multipart/form-data:
 *   package     the AEM package ZIP
 *   site        live site domain, e.g. https://www.abbvie.co.nz
 *   assetMapName / assetMapFile, updateAlt, updateCaption, includeCardImage, includeFragments (optional)
 * Streams NDJSON progress events and finishes with a "result" event.
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
  let site: string;
  try {
    site = normalizeSite(String(form.get("site") ?? ""));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Invalid live site domain" }, { status: 400 });
  }
  const asset = await assetMapFromForm(form);
  if ("error" in asset) return Response.json({ error: asset.error }, { status: 400 });

  const flag = (name: string, fallback: boolean) => {
    const v = form.get(name);
    return v === null ? fallback : v === "true";
  };
  const packageBytes = new Uint8Array(await pkg.arrayBuffer());
  const base = pkg.name.replace(/\.zip$/i, "");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AutoUpdateStreamEvent | AutoUpdateEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // client disconnected
        }
      };
      try {
        const result = await autoUpdatePackage(
          packageBytes,
          site,
          asset.map,
          {
            updateAlt: flag("updateAlt", DEFAULT_UPDATE_OPTIONS.updateAlt),
            updateCaption: flag("updateCaption", DEFAULT_UPDATE_OPTIONS.updateCaption),
            includeCardImage: flag("includeCardImage", DEFAULT_UPDATE_OPTIONS.includeCardImage),
            includeFragments: flag("includeFragments", DEFAULT_UPDATE_OPTIONS.includeFragments),
            signal: request.signal,
          },
          send,
        );
        send({
          type: "result",
          assetMap: asset.name,
          site: result.site,
          pagesInPackage: result.pagesInPackage,
          pagesCrawled: result.pagesCrawled,
          pagesNotLive: result.pagesNotLive,
          summary: result.summary,
          changes: result.changes.slice(0, MAX_PREVIEW_ROWS),
          changesTotal: result.changes.length,
          packageName: `${base}-alt-updated.zip`,
          packageBase64: Buffer.from(result.zip).toString("base64"),
          reportName: `${base}-alt-update-report.csv`,
          reportCsv: result.reportCsv,
          liveCsvName: `${base}-live-images.csv`,
          liveCsv: result.liveCsv,
        });
      } catch (err) {
        if (!request.signal.aborted) send({ type: "fatal", message: err instanceof Error ? err.message : String(err) });
      }
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
