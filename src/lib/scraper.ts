import { newScrapeContext, renderAndExtract, toImageRecords } from "./browser";
import type { ImageRecord } from "./types";

export interface ScrapeResult {
  title: string;
  images: ImageRecord[];
}

/** Renders a single page fully (images not blocked, so dimensions are accurate). */
export async function scrapePage(url: string): Promise<ScrapeResult> {
  const context = await newScrapeContext({ blockResources: false });
  try {
    const page = await context.newPage();
    const { title, finalUrl, images } = await renderAndExtract(page, url);
    return { title, images: toImageRecords(finalUrl, images) };
  } finally {
    await context.close().catch(() => {});
  }
}
