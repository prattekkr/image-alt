import { loadAssetMapForStream } from "@/lib/assetMap";
import { friendlyError, runPool } from "@/lib/crawler";
import { scrapePage } from "@/lib/scraper";
import type { StreamEvent } from "@/lib/types";

export const maxDuration = 300;

const MAX_URLS = 25;

function normalizeUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const urls = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    let candidate = item.trim();
    if (!candidate) continue;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.add(parsed.href);
    } catch {
      // ignore invalid URLs
    }
  }
  return [...urls];
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const urls = normalizeUrls((body as { urls?: unknown })?.urls);
  if (urls.length === 0) {
    return Response.json({ error: "Provide at least one valid http(s) URL" }, { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return Response.json({ error: `A maximum of ${MAX_URLS} URLs is allowed per run` }, { status: 400 });
  }

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
      const assetMap = await loadAssetMapForStream(send);
      await runPool(urls, 4, request.signal, async (url) => {
        send({ type: "page-start", url });
        try {
          const { title, images } = await scrapePage(url);
          send({ type: "page-done", url, title, images: assetMap ? assetMap.enrich(images) : images });
        } catch (err) {
          send({ type: "page-error", url, message: friendlyError(err) });
        }
      });
      send({ type: "done" });
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
