import { loadAssetMapForStream } from "@/lib/assetMap";
import { CONCURRENCY_LIMITS, crawlSitemap, MAX_PAGES_LIMIT } from "@/lib/crawler";
import type { CrawlMode, StreamEvent } from "@/lib/types";

export const maxDuration = 800;

export async function POST(request: Request) {
  let body: { sitemapUrl?: unknown; mode?: unknown; concurrency?: unknown; maxPages?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let sitemapUrl = typeof body.sitemapUrl === "string" ? body.sitemapUrl.trim() : "";
  if (sitemapUrl && !/^[a-z][a-z\d+.-]*:\/\//i.test(sitemapUrl)) sitemapUrl = `https://${sitemapUrl}`;
  try {
    const parsed = new URL(sitemapUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    sitemapUrl = parsed.href;
  } catch {
    return Response.json({ error: "Provide a valid http(s) sitemap URL" }, { status: 400 });
  }

  const mode: CrawlMode = body.mode === "render" ? "render" : "fast";
  const concurrency = Number(body.concurrency) || CONCURRENCY_LIMITS[mode].default;
  const maxPages = Number(body.maxPages) > 0 ? Number(body.maxPages) : MAX_PAGES_LIMIT;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // client disconnected
        }
      };
      try {
        const assetMap = await loadAssetMapForStream(send);
        await crawlSitemap(sitemapUrl, { mode, concurrency, maxPages, signal: request.signal, assetMap }, send);
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

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
