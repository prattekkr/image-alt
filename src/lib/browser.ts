import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { extractImagesFromDocument, type RawImage } from "./extractor";
import type { AltStatus, ImageRecord } from "./types";

// A real browser UA is required; Cloudflare rejects the default HeadlessChrome UA.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;

// `__name` shim: tsx/esbuild may wrap functions with __name(), which doesn't exist in the page.
const INIT_SCRIPT = `globalThis.__name = globalThis.__name || ((f) => f);
globalThis.__extractImages = ${extractImagesFromDocument.toString()};`;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);
const BLOCKED_HOSTS =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|facebook\.net|facebook\.com|t\.co|twitter\.com|ads-twitter\.com|licdn\.com|linkedin\.com|hotjar\.com|clarity\.ms|bing\.com|demdex\.net|omtrdc\.net|adobedtm\.com|cookielaw\.org|onetrust\.com|qualtrics\.com|youtube\.com|ytimg\.com|vimeo\.com|brightcove\.net|newrelic\.com|nr-data\.net)$/i;

const globalForBrowser = globalThis as unknown as { __browserPromise?: Promise<Browser> | null };

export function getBrowser(): Promise<Browser> {
  if (!globalForBrowser.__browserPromise) {
    globalForBrowser.__browserPromise = chromium
      .launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })
      .then((browser) => {
        browser.on("disconnected", () => {
          globalForBrowser.__browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        globalForBrowser.__browserPromise = null;
        throw err;
      });
  }
  return globalForBrowser.__browserPromise;
}

export async function closeBrowser() {
  const browser = await globalForBrowser.__browserPromise?.catch(() => null);
  globalForBrowser.__browserPromise = null;
  await browser?.close().catch(() => {});
}

/** Creates an isolated browser context. `blockResources` skips images/fonts/media/trackers for speed. */
export async function newScrapeContext({ blockResources }: { blockResources: boolean }): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  await context.addInitScript({ content: INIT_SCRIPT });
  if (blockResources) {
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = request.url();
      // Never interfere with Cloudflare's challenge assets or it can't complete.
      if (url.includes("/cdn-cgi/") || url.includes("challenges.cloudflare.com")) return route.continue();
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) return route.abort();
      try {
        if (BLOCKED_HOSTS.test(new URL(url).hostname)) return route.abort();
      } catch {
        // ignore unparsable URLs
      }
      return route.continue();
    });
  }
  return context;
}

/** Waits for a Cloudflare-style JS challenge to resolve. Returns false if it never does. */
export async function waitForChallenge(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (CHALLENGE_TITLE.test(await page.title().catch(() => ""))) {
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(500);
  }
  return true;
}

export interface PageExtraction {
  title: string;
  finalUrl: string;
  images: RawImage[];
}

export interface RenderOptions {
  /** Max time to wait for network idle after load. */
  idleTimeoutMs?: number;
  scrollDelayMs?: number;
}

/** Raised when the site serves a bot challenge or rate-limits us; callers should back off and retry. */
export class BlockedError extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = "BlockedError";
  }
}

/** Loads a URL in a real tab (runs JS, scrolls for lazy images) and extracts images. */
export async function renderAndExtract(page: Page, url: string, opts: RenderOptions = {}): Promise<PageExtraction> {
  const { idleTimeoutMs = 15_000, scrollDelayMs = 150 } = opts;
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const status = response?.status() ?? 0;
  // A 429 challenge is rate limiting; it won't clear by waiting in this tab.
  if (status === 429) throw new BlockedError("Rate limited by the site (HTTP 429)", true);

  const challenged = CHALLENGE_TITLE.test(await page.title().catch(() => ""));
  if (challenged && !(await waitForChallenge(page, 20_000))) {
    throw new BlockedError("Blocked by a bot-protection challenge (Cloudflare)", false);
  }
  if (status >= 400 && !challenged) throw new Error(`HTTP ${status}`);
  const title = await page.title().catch(() => "");

  await page.waitForLoadState("networkidle", { timeout: idleTimeoutMs }).catch(() => {});
  await autoScroll(page, scrollDelayMs);
  await page.waitForLoadState("networkidle", { timeout: Math.min(idleTimeoutMs, 5_000) }).catch(() => {});

  const images = await page.evaluate(() =>
    (globalThis as unknown as { __extractImages: (d: Document, b: string) => RawImage[] }).__extractImages(
      document,
      document.baseURI,
    ),
  );
  return { title, finalUrl: page.url(), images };
}

async function autoScroll(page: Page, delayMs: number) {
  // Scroll in steps so lazy-loaded images (loading="lazy", IntersectionObserver) get real sources.
  await page.evaluate(async (delay) => {
    const step = 800;
    for (let i = 0; i < 80; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, delay));
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) break;
    }
    window.scrollTo(0, 0);
  }, delayMs);
}

export function altStatusOf(alt: string | null): AltStatus {
  if (alt === null) return "missing";
  return alt.trim() ? "present" : "empty";
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function toImageRecords(pageUrl: string, raw: RawImage[]): ImageRecord[] {
  const pagePath = pathOf(pageUrl);
  return raw.map((img, i) => ({
    id: `${pageUrl}#${i}`,
    pageUrl,
    pagePath,
    imageUrl: img.src,
    altText: img.alt ?? "",
    altStatus: altStatusOf(img.alt),
    caption: img.caption,
    captionSource: img.captionSource,
    width: img.width,
    height: img.height,
    damPath: img.damPath,
    edsImagePath: "",
    edsMatch: "",
  }));
}
